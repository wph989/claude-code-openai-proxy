import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ConfigRepository } from './repository.js';
import { SqliteConfigRepository } from './sqlite-config-repository.js';

export interface ConfigRepositoryFactoryOptions {
  sqlitePath: string;
}

export async function createConfigRepository(
  options: ConfigRepositoryFactoryOptions,
): Promise<ConfigRepository> {
  const sqlitePath = path.resolve(options.sqlitePath);
  await mkdir(path.dirname(sqlitePath), { recursive: true });
  return new SqliteConfigRepository(sqlitePath);
}
