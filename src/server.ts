import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { settings } from './config.js';
import { RuntimeConfigManager } from './services/runtime-config.js';
import { UpstreamService } from './services/upstream.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerChatCompletionsRoutes } from './routes/chat-completions.js';
import { registerMessageRoutes } from './routes/messages.js';
import { createId } from './utils/id.js';
import { log, setLogDetailed, setLogFormat, setLogLevel, flushLogs } from './utils/logger.js';

declare module 'fastify' {
  interface FastifyInstance {
    runtimeConfigManager: RuntimeConfigManager;
    upstreamService: UpstreamService;
  }
  interface FastifyRequest {
    requestId: string;
    sessionId: string;
  }
}

export async function createApp(configPath = settings.configFile): Promise<FastifyInstance> {
  setLogLevel(settings.logLevel);
  setLogFormat(settings.logFormat);
  setLogDetailed(settings.logDetailed);
  const app = Fastify({
    logger: false,
    bodyLimit: 20 * 1024 * 1024
  });

  await app.register(cookie);

  app.decorate('runtimeConfigManager', new RuntimeConfigManager(configPath));
  app.decorate('upstreamService', new UpstreamService());

  await app.runtimeConfigManager.init();

  app.addHook('onRequest', async (request) => {
    request.requestId = createId('req');
    const sessionHeader = request.headers['x-claude-code-session-id'];
    request.sessionId = typeof sessionHeader === 'string' && sessionHeader.trim() ? sessionHeader.trim() : createId('session');
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const err = error instanceof Error ? error : new Error(String(error));
    log('error', '服务处理失败', { request_id: request.requestId, error });
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
  log('info', '服务启动成功', {
    host: options.host,
    port: options.port,
    config_file: options.configPath || settings.configFile
  });

  // 使用同步退出防止日志丢失：先 close server，再 flush 日志，再 exit
  let shuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', '收到退出信号，准备关闭服务', { signal });
    try {
      await app.close();
    } catch {
      // ignore
    }
    await flushLogs();
    process.exit(0);
  };

  process.once('SIGINT', () => void handleShutdown('SIGINT'));
  process.once('SIGTERM', () => void handleShutdown('SIGTERM'));
}
