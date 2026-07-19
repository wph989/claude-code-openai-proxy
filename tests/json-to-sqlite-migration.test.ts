import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  autoMigrateJsonToSqlite,
  migrateJsonToSqlite,
} from '../src/services/config/json-to-sqlite-migration.js';
import { SqliteConfigRepository } from '../src/services/config/sqlite-config-repository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'ccop-json-migration-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('JSON 到 SQLite 显式迁移', () => {
  it('dry-run 校验全部源文件但不创建数据库或修改 JSON', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    const statePath = path.join(tempDir, 'runtime_state.json');
    const usagePath = path.join(tempDir, 'custom_usage.json');
    const historyPath = path.join(tempDir, 'runtime_history.json');
    const dbPath = path.join(tempDir, 'runtime.db');
    writeJson(configPath, runtimeConfig(3, {
      anti_ban: { quota: { usage_file: 'custom_usage.json' } },
    }));
    writeJson(statePath, {
      version: 2,
      states: { 'provider-a:STABLE0001': { error_count: 2, last_error_at: 123 } },
    });
    writeJson(usagePath, {
      version: 2,
      usage: {
        'provider-a:STABLE0001': {
          requests_used: 4,
          tokens_used: 50,
          input_tokens_used: 30,
          output_tokens_used: 20,
          cost_usd: 0.01,
        },
      },
    });
    writeJson(historyPath, {
      version: 1,
      entries: [{ revision: 2, createdAt: 1000, config: runtimeConfig(2) }],
    });
    const originals = new Map(
      [configPath, statePath, usagePath, historyPath]
        .map((filePath) => [filePath, readFileSync(filePath, 'utf8')]),
    );

    const result = await migrateJsonToSqlite({ configPath, sqlitePath: dbPath, dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      revision: 3,
      providerCount: 1,
      routeCount: 1,
      keyCount: 1,
      stateCount: 1,
      usageCount: 1,
      historyCount: 1,
    });
    expect(result.sourceFiles).toEqual([configPath, statePath, usagePath, historyPath]);
    expect(existsSync(dbPath)).toBe(false);
    for (const [filePath, content] of originals) {
      expect(readFileSync(filePath, 'utf8')).toBe(content);
    }
  });

  it('原子导入配置、状态、用量和历史并保留稳定 ID', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    const dbPath = path.join(tempDir, 'runtime.db');
    writeJson(configPath, runtimeConfig(5));
    writeJson(path.join(tempDir, 'runtime_state.json'), {
      version: 2,
      states: { 'provider-a:STABLE0001': { enabled: false, error_count: 7 } },
    });
    writeJson(path.join(tempDir, 'runtime_usage.json'), {
      version: 2,
      usage: { 'provider-a:STABLE0001': { requests_used: 8, tokens_used: 90 } },
    });
    writeJson(path.join(tempDir, 'runtime_history.json'), {
      version: 1,
      entries: [{ revision: 4, createdAt: 2000, config: runtimeConfig(4) }],
    });

    await migrateJsonToSqlite({ configPath, sqlitePath: dbPath });
    const repository = new SqliteConfigRepository(dbPath);
    try {
      const config = await repository.loadConfig();
      expect(config.revision).toBe(5);
      expect(config.providers[0].api_key).toEqual([
        expect.objectContaining({ id: 'STABLE0001', key: 'placeholder-key' }),
      ]);
      expect(await repository.createKeyStateStore().load()).toMatchObject({
        'provider-a:STABLE0001': { enabled: false, error_count: 7 },
      });
      expect(await repository.createUsageStore().load()).toEqual({
        'provider-a:STABLE0001': { requests_used: 8, tokens_used: 90 },
      });
      expect((await repository.listConfigHistory(10)).map((entry) => entry.revision)).toEqual([5, 4]);
    } finally {
      repository.close();
    }
  });

  it('完整迁移已停用的 Provider 和模型且保留 enabled=false', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    const dbPath = path.join(tempDir, 'ccop.db');
    const config = runtimeConfig(6);
    config.providers[0].enabled = false;
    config.models[0].enabled = false;
    writeJson(configPath, config);

    const result = await migrateJsonToSqlite({ configPath, sqlitePath: dbPath });
    expect(result).toMatchObject({ providerCount: 1, routeCount: 1 });

    const repository = new SqliteConfigRepository(dbPath);
    try {
      const migrated = await repository.loadConfig();
      expect(migrated.providers).toHaveLength(1);
      expect(migrated.providers[0]).toMatchObject({ provider_id: 'provider-a', enabled: false });
      expect(migrated.models).toHaveLength(1);
      expect(migrated.models[0]).toMatchObject({ client_model: 'client-model', enabled: false });
    } finally {
      repository.close();
    }
  });

  it.each([
    ['Key 状态', 'runtime_state.json', { version: 1, states: {} }, 'version=2'],
    ['用量', 'runtime_usage.json', { version: 1, usage: {} }, 'version=2'],
    ['配置历史', 'runtime_history.json', { version: 2, entries: [] }, 'version=1'],
  ])('拒绝错误版本的%s文件且不创建目标库', async (_label, filename, value, message) => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    const dbPath = path.join(tempDir, 'runtime.db');
    writeJson(configPath, runtimeConfig(1));
    writeJson(path.join(tempDir, filename), value);

    await expect(migrateJsonToSqlite({ configPath, sqlitePath: dbPath })).rejects.toThrow(message);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('拒绝覆盖已初始化数据库', async () => {
    const configPath = path.join(tempDir, 'missing-runtime-models.json');
    const dbPath = path.join(tempDir, 'runtime.db');
    const repository = new SqliteConfigRepository(dbPath);
    await repository.ensureDefaultConfig(() => runtimeConfig(1));
    repository.close();

    await expect(migrateJsonToSqlite({ configPath, sqlitePath: dbPath }))
      .rejects.toThrow('目标库已初始化');
    const reopened = new SqliteConfigRepository(dbPath);
    try {
      expect((await reopened.loadConfig()).revision).toBe(1);
    } finally {
      reopened.close();
    }
  });
});

describe('JSON 到 SQLite 启动自动迁移', () => {
  it('目标未初始化时自动迁移且不修改源 JSON', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    const dbPath = path.join(tempDir, 'runtime.db');
    writeJson(configPath, runtimeConfig(6));
    const original = readFileSync(configPath, 'utf8');

    const result = await autoMigrateJsonToSqlite({ configPath, sqlitePath: dbPath });

    expect(result.status).toBe('migrated');
    if (result.status !== 'migrated') throw new Error('自动迁移结果类型错误');
    expect(result.result.revision).toBe(6);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    const repository = new SqliteConfigRepository(dbPath);
    try {
      expect((await repository.loadConfig()).revision).toBe(6);
    } finally {
      repository.close();
    }
  });

  it('目标已初始化时跳过且不读取不存在的源文件', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const repository = new SqliteConfigRepository(dbPath);
    await repository.ensureDefaultConfig(() => runtimeConfig(4));
    repository.close();

    const result = await autoMigrateJsonToSqlite({
      configPath: path.join(tempDir, 'missing-runtime-models.json'),
      sqlitePath: dbPath,
    });

    expect(result).toEqual({ status: 'skipped', sqlitePath: dbPath, revision: 4 });
  });

  it('未配置迁移源时不创建或检查目标数据库', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');

    await expect(autoMigrateJsonToSqlite({ configPath: null, sqlitePath: dbPath }))
      .resolves.toEqual({ status: 'disabled', sqlitePath: dbPath });
    expect(existsSync(dbPath)).toBe(false);
  });

  it('默认来源不存在时保持禁用，让启动流程创建默认配置', async () => {
    const dbPath = path.join(tempDir, 'ccop.db');

    await expect(autoMigrateJsonToSqlite({
      configPath: path.join(tempDir, 'runtime_models.json'),
      sqlitePath: dbPath,
      sourceRequired: false,
    })).resolves.toEqual({ status: 'disabled', sqlitePath: dbPath });
    expect(existsSync(dbPath)).toBe(false);
  });

  it('拒绝向非 CCOP SQLite 数据库自动迁移', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    const dbPath = path.join(tempDir, 'other.db');
    writeJson(configPath, runtimeConfig(1));
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE unrelated_data(id INTEGER PRIMARY KEY)');
    db.close();

    await expect(autoMigrateJsonToSqlite({ configPath, sqlitePath: dbPath }))
      .rejects.toThrow('目标包含非 CCOP 数据');
    expect(readFileSync(configPath, 'utf8')).toContain('provider-a');
  });

  it('源 JSON 校验失败时不创建目标数据库', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    const dbPath = path.join(tempDir, 'runtime.db');
    writeFileSync(configPath, '{ invalid json', 'utf8');

    await expect(autoMigrateJsonToSqlite({ configPath, sqlitePath: dbPath }))
      .rejects.toThrow('主配置读取失败');
    expect(existsSync(dbPath)).toBe(false);
  });
});

function runtimeConfig(revision: number, extra: Record<string, unknown> = {}) {
  return {
    revision,
    providers: [{
      provider_id: 'provider-a',
      provider_type: 'openai_compatible',
      base_url: 'https://example.com/v1',
      api_key: [{ id: 'STABLE0001', key: 'placeholder-key', enabled: true }],
      enabled: true,
      headers: {},
    }],
    models: [{
      route_id: 'ROUTESTBL1',
      client_model: 'client-model',
      provider_id: 'provider-a',
      upstream_model: 'upstream-model',
      enabled: true,
    }],
    default_client_model: 'client-model',
    proxy_auth_token: null,
    ...extra,
  };
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
