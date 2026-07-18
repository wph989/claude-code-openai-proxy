import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createApp, type CreateAppDependencies } from '../src/server.js';
import { migrateJsonToSqlite } from '../src/services/config/json-to-sqlite-migration.js';
import { SqliteConfigRepository } from '../src/services/config/sqlite-config-repository.js';
import { RuntimeConfigManager } from '../src/services/runtime-config.js';

/** 测试也必须走显式迁移，防止夹具无意中重新引入生产运行时的 JSON 兼容入口。 */
export async function createMigratedApp(
  configPath: string,
  dependencies: CreateAppDependencies = {},
): Promise<FastifyInstance> {
  const sqlitePath = path.join(path.dirname(configPath), `.ccop-test-${randomUUID()}.db`);
  await migrateJsonToSqlite({ configPath, sqlitePath });
  return createApp(sqlitePath, dependencies);
}

export async function createMigratedManager(
  configPath: string,
  randomSource: () => number = Math.random,
): Promise<RuntimeConfigManager> {
  const sqlitePath = getManagerSqlitePath(configPath);
  if (!existsSync(sqlitePath)) await migrateJsonToSqlite({ configPath, sqlitePath });
  return new RuntimeConfigManager(new SqliteConfigRepository(sqlitePath), randomSource);
}

export function getManagerSqlitePath(configPath: string): string {
  const filename = path.basename(configPath, path.extname(configPath));
  return path.join(path.dirname(configPath), `.ccop-test-${filename}.db`);
}
