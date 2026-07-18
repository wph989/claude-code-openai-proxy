import type { FastifyInstance } from 'fastify';
import { registerAdminConfigRoutes } from './admin/config.js';
import { registerAdminKeyRoutes } from './admin/keys.js';
import { registerAdminSessionRoutes } from './admin/session.js';
import { registerAdminEventRoutes } from './admin/events.js';
import { registerAdminProviderActionRoutes } from './admin/providers.js';

// 兼容历史 import；实现已按 session/config/keys 分组，门面只负责组装。
export { parseConfigRevision, safeKeyExportFilename } from './admin/shared.js';

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await registerAdminSessionRoutes(app);
  await registerAdminEventRoutes(app);
  await registerAdminProviderActionRoutes(app);
  await registerAdminConfigRoutes(app);
  await registerAdminKeyRoutes(app);
}
