import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getExpectedAdminToken, isValidAdminToken, verifyAdminAuth } from '../auth.js';
import { settings } from '../config.js';
import type { RuntimeConfig, KeyQuotaConfig } from '../models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.join(__dirname, '..', 'static');

export function safeKeyExportFilename(providerId: string): string {
  // provider_id 来自用户配置；下载头只允许保守字符，避免异常字符污染响应头。
  const cleaned = String(providerId || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return `${cleaned || 'provider'}-keys.txt`;
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const staticCache = new Map<string, string>();

  async function serveStatic(reply: FastifyReply, filename: string, contentType: string): Promise<void> {
    if (!staticCache.has(filename)) {
      staticCache.set(filename, await readFile(path.join(staticDir, filename), 'utf-8'));
    }
    void reply.type(contentType).send(staticCache.get(filename));
  }

  app.get('/admin.css', async (_request, reply) => {
    await serveStatic(reply, 'admin.css', 'text/css; charset=utf-8');
  });

  app.get('/admin.js', async (_request, reply) => {
    await serveStatic(reply, 'admin.js', 'application/javascript; charset=utf-8');
  });

  app.get('/', async (request, reply) => {
    const token = request.cookies?.[settings.adminCookieName];
    void reply.redirect(token && isValidAdminToken(token) ? '/admin' : '/login');
  });

  app.get('/login', async (_request, reply) => {
    await serveStatic(reply, 'login.html', 'text/html; charset=utf-8');
  });

  app.post('/api/admin/login', async (request, reply) => {
    const body = (request.body || {}) as { token?: string };
    const token = String(body.token || '').trim();
    if (token !== getExpectedAdminToken()) {
      return reply.code(401).send({ message: '管理口令错误。' });
    }
    reply.setCookie(settings.adminCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: settings.adminCookieMaxAgeSeconds
    });
    return { message: '登录成功。' };
  });

  app.post('/api/admin/logout', async (_request, reply) => {
    reply.clearCookie(settings.adminCookieName, { path: '/' });
    return { message: '已退出登录。' };
  });

  app.get('/api/admin/session', async (request) => {
    const token = request.cookies?.[settings.adminCookieName];
    return { authenticated: Boolean(token && isValidAdminToken(token)) };
  });

  app.get('/admin', async (request, reply) => {
    const token = request.cookies?.[settings.adminCookieName];
    if (!token || !isValidAdminToken(token)) {
      return reply.redirect('/login');
    }
    await serveStatic(reply, 'index.html', 'text/html; charset=utf-8');
  });

  app.get('/api/config', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    await app.runtimeConfigManager.flushRuntimeStores();
    return app.runtimeConfigManager.adminView();
  });

  app.put('/api/config', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    const payload = (request.body || {}) as RuntimeConfig;
    const config = await app.runtimeConfigManager.saveConfig(payload);
    return {
      message: '配置已保存，并已立即生效。',
      config,
      summary: app.runtimeConfigManager.summary(),
      provider_options: config.providers.map((item) => ({
        provider_id: item.provider_id,
        label: `${item.provider_id} (${item.enabled !== false ? '启用' : '停用'})`
      }))
    };
  });

  app.get('/api/keys/:providerId', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    const { providerId } = request.params as { providerId: string };
    await app.runtimeConfigManager.flushRuntimeStores();
    const keys = app.runtimeConfigManager.getKeyStates(providerId);
    return { provider_id: providerId, keys };
  });

  app.get('/api/keys/:providerId/export', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    const { providerId } = request.params as { providerId: string };
    await app.runtimeConfigManager.flushRuntimeStores();
    const keys = app.runtimeConfigManager.getKeyStates(providerId);
    const text = keys.map((k) => k.key).join('\n');
    void reply.type('text/plain; charset=utf-8').header('content-disposition', `attachment; filename="${safeKeyExportFilename(providerId)}"`).send(text);
  });

  app.put('/api/keys/:providerId/:keyIndex/enable', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    const { providerId, keyIndex } = request.params as { providerId: string; keyIndex: string };
    const idx = parseInt(keyIndex, 10);
    if (isNaN(idx) || idx < 0) {
      return reply.code(400).send({ message: '无效的 keyIndex。' });
    }
    try {
      await app.runtimeConfigManager.enableKey(providerId, idx);
      return { message: 'Key 已启用。', provider_id: providerId, key_index: idx };
    } catch (err) {
      return reply.code(400).send({ message: err instanceof Error ? err.message : '启用失败。' });
    }
  });

  app.put('/api/keys/:providerId/:keyIndex/disable', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    const { providerId, keyIndex } = request.params as { providerId: string; keyIndex: string };
    const idx = parseInt(keyIndex, 10);
    if (isNaN(idx) || idx < 0) {
      return reply.code(400).send({ message: '无效的 keyIndex。' });
    }
    try {
      await app.runtimeConfigManager.disableKey(providerId, idx);
      return { message: 'Key 已禁用。', provider_id: providerId, key_index: idx };
    } catch (err) {
      return reply.code(400).send({ message: err instanceof Error ? err.message : '禁用失败。' });
    }
  });

  app.put('/api/keys/:providerId/:keyIndex/reset', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    const { providerId, keyIndex } = request.params as { providerId: string; keyIndex: string };
    const idx = parseInt(keyIndex, 10);
    if (isNaN(idx) || idx < 0) {
      return reply.code(400).send({ message: '无效的 keyIndex。' });
    }
    try {
      await app.runtimeConfigManager.resetKey(providerId, idx);
      return { message: 'Key 已重置并启用。', provider_id: providerId, key_index: idx };
    } catch (err) {
      return reply.code(400).send({ message: err instanceof Error ? err.message : '重置失败。' });
    }
  });

  app.put('/api/keys/:providerId/reset-all', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    const { providerId } = request.params as { providerId: string };
    try {
      const count = await app.runtimeConfigManager.resetAllKeys(providerId);
      return { message: `已重置 ${providerId} 的 ${count} 个 Key`, provider_id: providerId, count };
    } catch (err) {
      return reply.code(400).send({ message: err instanceof Error ? err.message : '重置失败。' });
    }
  });

  app.post('/api/keys/:providerId', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    const { providerId } = request.params as { providerId: string };
    const body = (request.body || {}) as { keys?: string[]; key?: string };
    const keyValues = body.keys || (body.key ? [body.key] : []);

    if (!Array.isArray(keyValues) || keyValues.length === 0) {
      return reply.code(400).send({ message: '至少需要一个 Key 值。' });
    }

    try {
      const result = await app.runtimeConfigManager.addKeys(providerId, keyValues);
      const addedCount = result.added.length;
      const skippedCount = result.skipped.length;

      let message = `添加完成：`;
      if (addedCount > 0) message += `新增 ${addedCount} 个`;
      if (skippedCount > 0) message += `${addedCount > 0 ? '，' : ''}跳过 ${skippedCount} 个（已存在）`;
      if (addedCount === 0 && skippedCount === 0) message = '没有有效的 Key 值';

      return {
        message,
        provider_id: providerId,
        added: result.added,
        skipped: result.skipped
      };
    } catch (err) {
      return reply.code(400).send({ message: err instanceof Error ? err.message : '添加失败。' });
    }
  });

  app.put('/api/keys/:providerId/:keyIndex/note', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    const { providerId, keyIndex } = request.params as { providerId: string; keyIndex: string };
    const idx = parseInt(keyIndex, 10);
    if (isNaN(idx) || idx < 0) {
      return reply.code(400).send({ message: '无效的 keyIndex。' });
    }
    const body = (request.body || {}) as { note?: string };
    try {
      await app.runtimeConfigManager.updateKeyState(providerId, idx, { note: String(body.note ?? '').trim() || undefined });
      return { message: '备注已更新。', provider_id: providerId, key_index: idx };
    } catch (err) {
      return reply.code(400).send({ message: err instanceof Error ? err.message : '更新备注失败。' });
    }
  });

  app.delete('/api/keys/:providerId/:keyIndex', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    const { providerId, keyIndex } = request.params as { providerId: string; keyIndex: string };
    const idx = parseInt(keyIndex, 10);
    if (isNaN(idx) || idx < 0) {
      return reply.code(400).send({ message: '无效的 keyIndex。' });
    }
    try {
      await app.runtimeConfigManager.deleteKey(providerId, idx);
      return { message: 'Key 已删除。', provider_id: providerId, key_index: idx };
    } catch (err) {
      return reply.code(400).send({ message: err instanceof Error ? err.message : '删除失败。' });
    }
  });

  app.post('/api/keys/:providerId/:keyIndex/quota/reset', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    const { providerId, keyIndex } = request.params as { providerId: string; keyIndex: string };
    const idx = parseInt(keyIndex, 10);
    if (isNaN(idx) || idx < 0) return reply.code(400).send({ message: '无效的 keyIndex。' });
    try {
      await app.runtimeConfigManager.resetKeyQuota(providerId, idx);
      return { message: '配额计数已清零。', provider_id: providerId, key_index: idx };
    } catch (err) {
      return reply.code(400).send({ message: err instanceof Error ? err.message : '重置配额失败。' });
    }
  });

  app.put('/api/keys/:providerId/:keyIndex/quota', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
    const { providerId, keyIndex } = request.params as { providerId: string; keyIndex: string };
    const idx = parseInt(keyIndex, 10);
    if (isNaN(idx) || idx < 0) return reply.code(400).send({ message: '无效的 keyIndex。' });
    const body = (request.body || {}) as { quota?: KeyQuotaConfig | null };
    const quota = body.quota ?? null;
    if (quota !== null) {
      if (quota.soft_stop_threshold !== undefined) {
        if (typeof quota.soft_stop_threshold !== 'number' || quota.soft_stop_threshold <= 0 || quota.soft_stop_threshold > 1) {
          return reply.code(400).send({ message: 'soft_stop_threshold 必须在 (0, 1] 之间。' });
        }
      }
      if (quota.max_requests != null && (typeof quota.max_requests !== 'number' || quota.max_requests <= 0)) {
        return reply.code(400).send({ message: 'max_requests 必须为正数或 null。' });
      }
      if (quota.max_tokens != null && (typeof quota.max_tokens !== 'number' || quota.max_tokens <= 0)) {
        return reply.code(400).send({ message: 'max_tokens 必须为正数或 null。' });
      }
    }
    try {
      await app.runtimeConfigManager.updateKeyQuota(providerId, idx, quota);
      return { message: '配额配置已更新。', provider_id: providerId, key_index: idx, quota };
    } catch (err) {
      return reply.code(400).send({ message: err instanceof Error ? err.message : '更新配额失败。' });
    }
  });
}
