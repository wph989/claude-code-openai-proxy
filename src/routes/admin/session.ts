import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getExpectedAdminToken, isValidAdminToken } from '../../auth.js';
import { settings } from '../../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.join(__dirname, '..', '..', 'static');

export async function registerAdminSessionRoutes(app: FastifyInstance): Promise<void> {
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
  app.get('/admin-ui.js', async (_request, reply) => {
    await serveStatic(reply, 'admin-ui.js', 'application/javascript; charset=utf-8');
  });
  app.get('/api-client.js', async (_request, reply) => {
    await serveStatic(reply, 'api-client.js', 'application/javascript; charset=utf-8');
  });
  app.get('/store.js', async (_request, reply) => {
    await serveStatic(reply, 'store.js', 'application/javascript; charset=utf-8');
  });
  for (const modulePath of [
    'forms/shared.js',
    'forms/provider-form.js',
    'forms/model-form.js',
    'components/data-table.js',
    'views/release-notes.js',
    'views/summary-view.js',
    'views/resource-rows.js',
    'views/key-panel.js',
    'views/activity-view.js',
  ]) {
    // 浏览器 ESM 只开放显式白名单，不能把整个 static 目录变成任意文件读取入口。
    app.get(`/${modulePath}`, async (_request, reply) => {
      await serveStatic(reply, modulePath, 'application/javascript; charset=utf-8');
    });
  }

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
      maxAge: settings.adminCookieMaxAgeSeconds,
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
    if (!token || !isValidAdminToken(token)) return reply.redirect('/login');
    await serveStatic(reply, 'index.html', 'text/html; charset=utf-8');
  });
}
