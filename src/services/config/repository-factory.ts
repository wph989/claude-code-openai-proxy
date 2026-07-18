import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ConfigRepository } from './repository.js';
import { JsonFileConfigRepository } from './json-file-repository.js';

export interface ConfigRepositoryFactoryOptions {
  storage: 'json' | 'sqlite';
  configPath: string;
  sqlitePath?: string;
}

export async function createConfigRepository(
  options: ConfigRepositoryFactoryOptions,
): Promise<ConfigRepository> {
  if (options.storage === 'json') return new JsonFileConfigRepository(options.configPath);

  const sqlitePath = path.resolve(
    options.sqlitePath || path.join(path.dirname(path.resolve(options.configPath)), 'runtime.db'),
  );
  await mkdir(path.dirname(sqlitePath), { recursive: true });
  try {
    // 动态加载使默认 JSON 模式在 Node 20 中不触碰 node:sqlite。
    const { SqliteConfigRepository } = await import('./sqlite-config-repository.js');
    return new SqliteConfigRepository(sqlitePath, { legacyConfigPath: options.configPath });
  } catch (error) {
    if (isMissingNodeSqlite(error)) {
      throw new Error('SQLite 存储要求 Node.js 22.5+；当前 Node 不提供 node:sqlite。');
    }
    throw error;
  }
}

function isMissingNodeSqlite(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  const message = error instanceof Error ? error.message : String(error);
  return code === 'ERR_UNKNOWN_BUILTIN_MODULE' || message.includes('node:sqlite');
}
