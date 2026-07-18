import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrateJsonToSqlite } from '../src/services/config/json-to-sqlite-migration.js';
import { SqliteConfigRepository } from '../src/services/config/sqlite-config-repository.js';

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
    const configPath = path.join(tempDir, 'runtime_models.json');
    const dbPath = path.join(tempDir, 'runtime.db');
    writeJson(configPath, runtimeConfig(2));
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
