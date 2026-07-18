import type { FastifyInstance } from 'fastify';
import { adminAuthHook } from '../../auth.js';
import { formatAdminEventSse } from '../../services/admin-event-stream.js';

const HEARTBEAT_INTERVAL_MS = 20_000;

export async function registerAdminEventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/events', { preHandler: [adminAuthHook] }, async (request, reply) => {
    const afterId = parseLastEventId(request.headers['last-event-id']);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');

    const unsubscribe = app.adminEventStream.subscribe((event) => {
      // 下游来不及读取时跳过即时推送，避免管理页连接拖垮代理请求；重连会从有界历史补回。
      if (!reply.raw.destroyed && !reply.raw.writableEnded && !reply.raw.writableNeedDrain) {
        reply.raw.write(formatAdminEventSse(event));
      }
    }, afterId);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(': heartbeat\n\n');
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    reply.raw.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}

function parseLastEventId(value: string | string[] | undefined): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
