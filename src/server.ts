import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { settings } from './config.js';
import { RuntimeConfigManager } from './services/runtime-config.js';
import { UpstreamService } from './services/upstream.js';
import { MetricsRegistry } from './services/metrics.js';
import { AdminEventStream } from './services/admin-event-stream.js';
import { ProviderConnectivityService } from './services/provider-connectivity.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerChatCompletionsRoutes } from './routes/chat-completions.js';
import { registerMessageRoutes } from './routes/messages.js';
import { createId } from './utils/id.js';
import { getDefaultLogger, type Logger } from './utils/logger.js';
import { AuthError } from './auth.js';
import { ClientInputError, ConfigConflictError, ConfigPreconditionError } from './errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    runtimeConfigManager: RuntimeConfigManager;
    upstreamService: UpstreamService;
    appLogger: Logger;
    metricsRegistry: MetricsRegistry;
    adminEventStream: AdminEventStream;
    providerConnectivity: ProviderConnectivityService;
  }
  interface FastifyRequest {
    requestId: string;
    sessionId: string;
    metricsStartedAt: bigint;
    metricsFirstByteAt?: bigint;
    metricsFinished: boolean;
  }
}

export interface CreateAppDependencies {
  logger?: Logger;
  metrics?: MetricsRegistry;
  adminEvents?: AdminEventStream;
  providerConnectivity?: ProviderConnectivityService;
}

export async function createApp(
  configPath = settings.configFile,
  dependencies: CreateAppDependencies = {},
): Promise<FastifyInstance> {
  const appLogger = dependencies.logger ?? getDefaultLogger();
  const metricsRegistry = dependencies.metrics ?? new MetricsRegistry();
  const adminEventStream = dependencies.adminEvents ?? new AdminEventStream();
  const providerConnectivity = dependencies.providerConnectivity ?? new ProviderConnectivityService();
  appLogger.configure(settings);
  const app = Fastify({
    logger: false,
    bodyLimit: 20 * 1024 * 1024
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    max: settings.rateLimitMax,
    timeWindow: settings.rateLimitTimeWindow,
    errorResponseBuilder: () => ({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: '请求过于频繁，请稍后重试。'
      }
    })
  });

  const runtimeConfigManager = new RuntimeConfigManager(configPath);
  runtimeConfigManager.setObserver(adminEventStream);
  app.decorate('runtimeConfigManager', runtimeConfigManager);
  app.decorate('appLogger', appLogger);
  app.decorate('metricsRegistry', metricsRegistry);
  app.decorate('adminEventStream', adminEventStream);
  app.decorate('providerConnectivity', providerConnectivity);
  app.decorate('upstreamService', new UpstreamService(appLogger, metricsRegistry));

  await app.runtimeConfigManager.init();

  app.addHook('onRequest', async (request) => {
    request.metricsStartedAt = process.hrtime.bigint();
    request.metricsFinished = false;
    app.metricsRegistry.requestStarted();
    request.requestId = createId('req');
    const sessionHeader = request.headers['x-claude-code-session-id'];
    request.sessionId = typeof sessionHeader === 'string' && sessionHeader.trim() ? sessionHeader.trim() : createId('session');
  });

  app.addHook('onSend', async (request, _reply, payload) => {
    request.metricsFirstByteAt ??= process.hrtime.bigint();
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    if (request.metricsFinished) return;
    request.metricsFinished = true;
    const finishedAt = process.hrtime.bigint();
    const firstByteAt = request.metricsFirstByteAt ?? finishedAt;
    const durationSeconds = Number(finishedAt - request.metricsStartedAt) / 1e9;
    const ttfbSeconds = Number(firstByteAt - request.metricsStartedAt) / 1e9;
    app.metricsRegistry.requestFinished({
      method: request.method,
      route: request.routeOptions.url || 'unmatched',
      statusCode: reply.statusCode,
      durationSeconds,
      ttfbSeconds,
    });
    app.adminEventStream.requestCompleted({
      method: request.method,
      route: request.routeOptions.url || 'unmatched',
      statusCode: reply.statusCode,
      durationMs: durationSeconds * 1000,
      ttfbMs: ttfbSeconds * 1000,
    });
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AuthError) {
      void reply.code(error.statusCode).send(error.body);
      return;
    }
    if (error instanceof ClientInputError) {
      void reply.code(error.statusCode).send({ message: error.message });
      return;
    }
    if (error instanceof ConfigConflictError) {
      void reply
        .code(error.statusCode)
        .header('etag', `"${error.currentRevision}"`)
        .send({ message: error.message, revision: error.currentRevision });
      return;
    }
    if (error instanceof ConfigPreconditionError) {
      void reply.code(error.statusCode).send({ message: error.message });
      return;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    app.appLogger.log('error', '服务处理失败', { error });
    void reply.code(500).send({
      type: 'error',
      error: {
        type: 'api_error',
        message: err.message || '服务器内部错误。'
      },
      request_id: request.requestId
    });
  });

  await registerHealthRoutes(app);
  await registerAdminRoutes(app);
  await registerChatCompletionsRoutes(app);
  await registerMessageRoutes(app);

  return app;
}

export async function startServer(options: { host: string; port: number; configPath?: string }): Promise<void> {
  const app = await createApp(options.configPath || settings.configFile);
  await app.listen({ host: options.host, port: options.port });
  app.appLogger.log('info', '服务启动成功', {
    host: options.host,
    port: options.port,
    config_file: options.configPath || settings.configFile
  });

  // 使用同步退出防止日志丢失：先 close server，再 flush 日志，再 exit
  let shuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.appLogger.log('info', '收到退出信号，准备关闭服务', { signal });
    try {
      // 先停止接收请求并等待在途处理完成，再冻结 Rotator 与持久化状态，避免关闭过程中遗漏最后一次状态变更。
      await app.close();
    } catch {
      // ignore
    }
    try {
      await app.runtimeConfigManager.shutdown();
    } catch {
      // ignore
    }
    await app.appLogger.flush();
    process.exit(0);
  };

  process.once('SIGINT', () => void handleShutdown('SIGINT'));
  process.once('SIGTERM', () => void handleShutdown('SIGTERM'));
}
