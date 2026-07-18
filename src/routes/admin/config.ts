import type { FastifyInstance, FastifyReply } from 'fastify';
import { adminAuthHook } from '../../auth.js';
import { AdminError } from '../../errors.js';
import { AdminConfigService, type GlobalSettingsPatch } from '../../services/admin-config-service.js';
import { parseConfigRevision, setRevisionHeaders } from './shared.js';

export async function registerAdminConfigRoutes(app: FastifyInstance): Promise<void> {
  const api = { preHandler: [adminAuthHook] };
  const service = new AdminConfigService(app.runtimeConfigManager);

  app.get('/api/config', api, async (_request, reply) => {
    await app.runtimeConfigManager.flushRuntimeStores();
    setRevisionHeaders(app, reply);
    return app.runtimeConfigManager.adminView();
  });

  app.get('/api/config/history', api, async (request, reply) => {
    const rawLimit = Number((request.query as { limit?: unknown }).limit ?? 20);
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;
    const history = await app.runtimeConfigManager.listConfigHistory(limit);
    setRevisionHeaders(app, reply);
    return { revision: app.runtimeConfigManager.getRevision(), history };
  });

  app.post('/api/config/history/:revision/rollback', api, async (request, reply) => {
    const expectedRevision = parseConfigRevision(request.headers['if-match']);
    const targetRevision = Number((request.params as { revision: string }).revision);
    if (!Number.isSafeInteger(targetRevision) || targetRevision <= 0) {
      throw new AdminError('历史 revision 必须是正整数。');
    }
    await app.runtimeConfigManager.rollbackConfig(targetRevision, expectedRevision);
    app.adminEventStream.configChanged({
      scope: 'config',
      action: 'rolled_back',
      revision: app.runtimeConfigManager.getRevision(),
    });
    setRevisionHeaders(app, reply);
    return {
      message: `已基于 revision ${targetRevision} 创建新的配置版本。`,
      ...app.runtimeConfigManager.adminView(),
    };
  });

  app.post('/api/config/preview', api, async (request, reply) => {
    const expectedRevision = parseConfigRevision(request.headers['if-match']);
    const preview = app.runtimeConfigManager.previewAdminConfig(request.body || {}, expectedRevision);
    setRevisionHeaders(app, reply);
    return { revision: app.runtimeConfigManager.getRevision(), ...preview };
  });

  app.put('/api/config/proxy-token', api, async (request, reply) => {
    const expectedRevision = parseConfigRevision(request.headers['if-match']);
    const body = (request.body || {}) as { token?: unknown };
    if (body.token !== null && typeof body.token !== 'string') {
      throw new AdminError('token 必须是字符串或 null。');
    }
    const token = typeof body.token === 'string' ? body.token.trim() || null : null;
    await app.runtimeConfigManager.updateProxyAuthToken(token, expectedRevision);
    app.adminEventStream.configChanged({
      scope: 'proxy_token',
      action: token ? 'rotated' : 'removed',
      revision: app.runtimeConfigManager.getRevision(),
    });
    setRevisionHeaders(app, reply);
    return {
      message: token ? '代理鉴权 Token 已轮换。' : '代理鉴权 Token 已移除。',
      revision: app.runtimeConfigManager.getRevision(),
      proxy_auth_token_configured: app.runtimeConfigManager.isProxyAuthTokenConfigured(),
    };
  });

  app.patch('/api/settings', api, async (request, reply) => {
    const expectedRevision = parseConfigRevision(request.headers['if-match']);
    await service.patchSettings((request.body || {}) as GlobalSettingsPatch, expectedRevision);
    app.adminEventStream.configChanged({
      scope: 'settings',
      action: 'updated',
      revision: app.runtimeConfigManager.getRevision(),
    });
    return sendSavedView(app, reply, '全局设置已更新。');
  });

  app.post('/api/providers', api, async (request, reply) => {
    const expectedRevision = parseConfigRevision(request.headers['if-match']);
    await service.createProvider(request.body || {}, expectedRevision);
    const providerId = readBodyString(request.body, 'provider_id');
    app.adminEventStream.configChanged({
      scope: 'provider',
      action: 'created',
      revision: app.runtimeConfigManager.getRevision(),
      providerId,
    });
    return sendSavedView(app, reply, '供应商已创建。');
  });
  app.patch('/api/providers/:providerId', api, async (request, reply) => {
    const expectedRevision = parseConfigRevision(request.headers['if-match']);
    const { providerId } = request.params as { providerId: string };
    await service.patchProvider(providerId, request.body || {}, expectedRevision);
    app.adminEventStream.configChanged({
      scope: 'provider',
      action: 'updated',
      revision: app.runtimeConfigManager.getRevision(),
      providerId,
    });
    return sendSavedView(app, reply, '供应商已更新。');
  });
  app.delete('/api/providers/:providerId', api, async (request, reply) => {
    const expectedRevision = parseConfigRevision(request.headers['if-match']);
    const { providerId } = request.params as { providerId: string };
    await service.deleteProvider(providerId, expectedRevision);
    app.adminEventStream.configChanged({
      scope: 'provider',
      action: 'deleted',
      revision: app.runtimeConfigManager.getRevision(),
      providerId,
    });
    return sendSavedView(app, reply, '供应商已删除。');
  });

  app.post('/api/routes', api, async (request, reply) => {
    const expectedRevision = parseConfigRevision(request.headers['if-match']);
    const routeId = await service.createRoute(request.body || {}, expectedRevision);
    app.adminEventStream.configChanged({
      scope: 'route',
      action: 'created',
      revision: app.runtimeConfigManager.getRevision(),
      routeId,
    });
    const response = sendSavedView(app, reply, '模型路由已创建。');
    return { ...response, route_id: routeId };
  });
  app.patch('/api/routes/:routeId', api, async (request, reply) => {
    const expectedRevision = parseConfigRevision(request.headers['if-match']);
    const { routeId } = request.params as { routeId: string };
    await service.patchRoute(routeId, request.body || {}, expectedRevision);
    app.adminEventStream.configChanged({
      scope: 'route',
      action: 'updated',
      revision: app.runtimeConfigManager.getRevision(),
      routeId,
    });
    return sendSavedView(app, reply, '模型路由已更新。');
  });
  app.delete('/api/routes/:routeId', api, async (request, reply) => {
    const expectedRevision = parseConfigRevision(request.headers['if-match']);
    const { routeId } = request.params as { routeId: string };
    await service.deleteRoute(routeId, expectedRevision);
    app.adminEventStream.configChanged({
      scope: 'route',
      action: 'deleted',
      revision: app.runtimeConfigManager.getRevision(),
      routeId,
    });
    return sendSavedView(app, reply, '模型路由已删除。');
  });
}

function sendSavedView(app: FastifyInstance, reply: FastifyReply, message: string) {
  setRevisionHeaders(app, reply);
  return { message, ...app.runtimeConfigManager.adminView() };
}

function readBodyString(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}
