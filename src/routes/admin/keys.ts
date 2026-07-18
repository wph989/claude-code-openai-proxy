import type { FastifyInstance, FastifyReply } from 'fastify';
import { adminAuthHook } from '../../auth.js';
import { KeyAdminService } from '../../services/key-admin-service.js';
import { safeKeyExportFilename, setRevisionHeaders } from './shared.js';

export async function registerAdminKeyRoutes(app: FastifyInstance): Promise<void> {
  const api = { preHandler: [adminAuthHook] };
  const service = new KeyAdminService(app.runtimeConfigManager);

  app.get('/api/keys/:providerId', api, async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const keys = await service.listKeys(providerId);
    setRevisionHeaders(app, reply);
    return { provider_id: providerId, keys };
  });

  app.get('/api/keys/:providerId/export', api, async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const keys = await service.exportKeys(providerId);
    app.appLogger.log('info', '管理员导出 Provider Key', {
      request_id: request.requestId,
      provider_id: providerId,
      key_count: keys.length,
    });
    app.adminEventStream.keyChanged({
      providerId,
      action: 'exported',
      count: keys.length,
      revision: app.runtimeConfigManager.getRevision(),
    });
    void reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-disposition', `attachment; filename="${safeKeyExportFilename(providerId)}"`)
      .send(keys.join('\n'));
  });

  app.put('/api/keys/:providerId/reset-all', api, async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const count = await service.resetAllKeys(providerId);
    app.adminEventStream.keyChanged({
      providerId,
      action: 'reset_all',
      count,
      revision: app.runtimeConfigManager.getRevision(),
    });
    setRevisionHeaders(app, reply);
    return { message: `已重置 ${providerId} 的 ${count} 个 Key`, provider_id: providerId, count };
  });

  app.post('/api/keys/:providerId', api, async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const result = await service.addKeys(providerId, request.body);
    app.adminEventStream.keyChanged({
      providerId,
      action: 'added',
      count: result.addedCount,
      revision: app.runtimeConfigManager.getRevision(),
    });
    setRevisionHeaders(app, reply);
    return {
      message: result.message,
      provider_id: providerId,
      added_count: result.addedCount,
      skipped_count: result.skippedCount,
    };
  });

  registerSingleKeyRoutes(app, api, service);
}

function registerSingleKeyRoutes(
  app: FastifyInstance,
  api: { preHandler: Array<typeof adminAuthHook> },
  service: KeyAdminService,
): void {
  app.put('/api/keys/:providerId/:keyRef/enable', api, async (request, reply) => {
    const { providerId, keyRef } = request.params as { providerId: string; keyRef: string };
    const keyId = resolveKeyId(service, providerId, keyRef, reply);
    await service.enableKey(providerId, keyId);
    setRevisionHeaders(app, reply);
    return { message: 'Key 已启用。', provider_id: providerId, key_id: keyId };
  });
  app.put('/api/keys/:providerId/:keyRef/disable', api, async (request, reply) => {
    const { providerId, keyRef } = request.params as { providerId: string; keyRef: string };
    const keyId = resolveKeyId(service, providerId, keyRef, reply);
    await service.disableKey(providerId, keyId);
    setRevisionHeaders(app, reply);
    return { message: 'Key 已禁用。', provider_id: providerId, key_id: keyId };
  });
  app.put('/api/keys/:providerId/:keyRef/reset', api, async (request, reply) => {
    const { providerId, keyRef } = request.params as { providerId: string; keyRef: string };
    const keyId = resolveKeyId(service, providerId, keyRef, reply);
    await service.resetKey(providerId, keyId);
    setRevisionHeaders(app, reply);
    return { message: 'Key 已重置并启用。', provider_id: providerId, key_id: keyId };
  });
  app.put('/api/keys/:providerId/:keyRef/note', api, async (request, reply) => {
    const { providerId, keyRef } = request.params as { providerId: string; keyRef: string };
    const keyId = resolveKeyId(service, providerId, keyRef, reply);
    await service.updateNote(providerId, keyId, request.body);
    app.adminEventStream.keyChanged({
      providerId,
      keyId,
      action: 'note_updated',
      revision: app.runtimeConfigManager.getRevision(),
    });
    setRevisionHeaders(app, reply);
    return { message: '备注已更新。', provider_id: providerId, key_id: keyId };
  });
  app.delete('/api/keys/:providerId/:keyRef', api, async (request, reply) => {
    const { providerId, keyRef } = request.params as { providerId: string; keyRef: string };
    const keyId = resolveKeyId(service, providerId, keyRef, reply);
    await service.deleteKey(providerId, keyId);
    app.adminEventStream.keyChanged({
      providerId,
      keyId,
      action: 'deleted',
      revision: app.runtimeConfigManager.getRevision(),
    });
    setRevisionHeaders(app, reply);
    return { message: 'Key 已删除。', provider_id: providerId, key_id: keyId };
  });
  app.post('/api/keys/:providerId/:keyRef/quota/reset', api, async (request, reply) => {
    const { providerId, keyRef } = request.params as { providerId: string; keyRef: string };
    const keyId = resolveKeyId(service, providerId, keyRef, reply);
    await service.resetQuota(providerId, keyId);
    return { message: '配额计数已清零。', provider_id: providerId, key_id: keyId };
  });
  app.put('/api/keys/:providerId/:keyRef/quota', api, async (request, reply) => {
    const { providerId, keyRef } = request.params as { providerId: string; keyRef: string };
    const keyId = resolveKeyId(service, providerId, keyRef, reply);
    const quota = await service.updateQuota(providerId, keyId, request.body);
    setRevisionHeaders(app, reply);
    return { message: '配额配置已更新。', provider_id: providerId, key_id: keyId, quota };
  });
}

function resolveKeyId(
  service: KeyAdminService,
  providerId: string,
  keyRef: string,
  reply: FastifyReply,
): string {
  const resolved = service.resolveReference(providerId, keyRef);
  if (resolved.legacyIndex !== null) {
    // 弃用提示属于 HTTP 兼容契约，因此留在路由层而不是污染应用服务。
    void reply.header('deprecation', 'true');
  }
  return resolved.keyId;
}
