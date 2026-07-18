import type { FastifyInstance } from 'fastify';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/livez', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    if (!app.runtimeConfigManager.isReady()) {
      return reply.code(503).send({ status: 'not_ready' });
    }
    return { status: 'ready', revision: app.runtimeConfigManager.getRevision() };
  });
  app.get('/metrics', async (_request, reply) => {
    return reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(app.metricsRegistry.renderPrometheus());
  });
}
