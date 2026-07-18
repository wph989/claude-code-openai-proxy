import type { FastifyInstance } from 'fastify';
import { adminAuthHook } from '../../auth.js';

export async function registerAdminProviderActionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/providers/:providerId/test', { preHandler: [adminAuthHook] }, async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const provider = app.runtimeConfigManager.resolveProvider(providerId);
    const result = await app.providerConnectivity.test(provider);
    app.adminEventStream.providerTested({
      providerId,
      providerType: provider.provider_type,
      ok: result.ok,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      category: result.category,
    });
    return reply.code(result.ok ? 200 : 502).send({
      provider_id: providerId,
      provider_type: provider.provider_type,
      ...result,
    });
  });
}
