import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { getExpectedAdminToken, isValidAdminToken, verifyAdminAuth } from '../auth.js';
import { settings } from '../config.js';
import type { RuntimeConfig } from '../models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.join(__dirname, '..', 'static');

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    const token = request.cookies?.[settings.adminCookieName];
    void reply.redirect(token && isValidAdminToken(token) ? '/admin' : '/login');
  });

  app.get('/login', async (_request, reply) => {
    const html = await readFile(path.join(staticDir, 'login.html'), 'utf-8');
    void reply.type('text/html; charset=utf-8').send(html);
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
    const html = await readFile(path.join(staticDir, 'index.html'), 'utf-8');
    void reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/api/config', async (request, reply) => {
    if (!(await verifyAdminAuth(request, reply))) return;
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
}
