import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigConflictError } from '../src/errors.js';
import { RuntimeConfigManager } from '../src/services/runtime-config.js';
import {
  SQLITE_SCHEMA_VERSION,
  SqliteConfigRepository,
} from '../src/services/config/sqlite-config-repository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'ccop-sqlite-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SqliteConfigRepository', () => {
  it('启用 WAL、执行显式 schema migration 并创建默认配置', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const repository = new SqliteConfigRepository(dbPath);
    const created = await repository.ensureDefaultConfig(() => emptyConfig(1));

    expect(created).toEqual(emptyConfig(1));
    expect(await repository.loadConfig()).toEqual(emptyConfig(1));
    expect(repository.queryPragma('journal_mode')).toMatchObject({ journal_mode: 'wal' });
    expect(repository.queryPragma('foreign_keys')).toMatchObject({ foreign_keys: 1 });
    expect(repository.queryPragma('user_version')).toMatchObject({ user_version: SQLITE_SCHEMA_VERSION });

    repository.close();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([
        { version: SQLITE_SCHEMA_VERSION },
      ]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='key_leases'").get())
        .toMatchObject({ name: 'key_leases' });
    } finally {
      db.close();
    }
  });

  it('首次建库原子导入 JSON 配置、Key 状态和用量并保留稳定 ID', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    const statePath = path.join(tempDir, 'runtime_state.json');
    const usagePath = path.join(tempDir, 'runtime_usage.json');
    const config = runtimeConfig(7);
    writeJson(configPath, config);
    writeJson(statePath, {
      version: 2,
      states: {
        'provider-a:STABLE0001': {
          error_count: 2,
          last_error_at: 123,
          last_error_message: 'temporary',
          disabled_at: null,
          auto_disabled_at: null,
        },
      },
    });
    writeJson(usagePath, {
      version: 2,
      usage: {
        'provider-a:STABLE0001': { requests_used: 11, tokens_used: 220 },
      },
    });
    const originalConfig = readFileSync(configPath, 'utf8');

    const repository = new SqliteConfigRepository(path.join(tempDir, 'runtime.db'), {
      legacyConfigPath: configPath,
    });
    const imported = await repository.ensureDefaultConfig(() => emptyConfig(1));

    expect(imported.revision).toBe(7);
    expect(imported.providers[0].api_key).toEqual([
      { id: 'STABLE0001', key: 'placeholder-key', enabled: true },
    ]);
    expect(await repository.createKeyStateStore().load()).toMatchObject({
      'provider-a:STABLE0001': { error_count: 2, last_error_at: 123 },
    });
    expect(await repository.createUsageStore({
      every_n: 1,
      critical_threshold: 0.9,
      usageFileHint: 'ignored.json',
    }).load()).toEqual({
      'provider-a:STABLE0001': { requests_used: 11, tokens_used: 220 },
    });
    expect(readFileSync(configPath, 'utf8')).toBe(originalConfig);

    repository.close();
  });

  it('两个连接通过 revision CAS 阻止旧 Worker 覆盖新配置', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const first = new SqliteConfigRepository(dbPath);
    const second = new SqliteConfigRepository(dbPath);
    await first.ensureDefaultConfig(() => emptyConfig(1));
    expect((await second.loadConfig()).revision).toBe(1);

    await first.saveConfig({ ...emptyConfig(2), default_client_model: 'first' }, 1);
    await expect(second.saveConfig({ ...emptyConfig(2), default_client_model: 'stale' }, 1))
      .rejects.toMatchObject<Partial<ConfigConflictError>>({ currentRevision: 2 });
    expect(await second.loadConfig()).toMatchObject({ revision: 2, default_client_model: 'first' });

    first.close();
    second.close();
  });

  it('Key 状态与用量在连接间立即可见，并按 desired 集合对齐', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const first = new SqliteConfigRepository(dbPath);
    const second = new SqliteConfigRepository(dbPath);
    await first.ensureDefaultConfig(() => emptyConfig(1));
    const firstState = first.createKeyStateStore();
    const secondState = second.createKeyStateStore();
    const firstUsage = first.createUsageStore({ every_n: 50, critical_threshold: 0.8, usageFileHint: '' });
    const secondUsage = second.createUsageStore({ every_n: 50, critical_threshold: 0.8, usageFileHint: '' });

    expect(firstState.reconcile(new Set(['p1:KEY0000001', 'p1:KEY0000002']), {
      error_count: 0,
      disabled_at: null,
      last_error_at: null,
      last_error_message: null,
      auto_disabled_at: null,
    })).toBe(true);
    firstState.update('p1:KEY0000001', { error_count: 4, enabled: false, disabled_at: 99 });
    expect(secondState.get('p1:KEY0000001')).toMatchObject({
      error_count: 4,
      enabled: false,
      disabled_at: 99,
    });

    expect(firstUsage.reconcile(new Set(['p1:KEY0000001', 'p1:KEY0000002']))).toBe(true);
    firstUsage.update('p1:KEY0000001', { requests_used: 5, tokens_used: 100 }, 0.5);
    expect(await secondUsage.load()).toMatchObject({
      'p1:KEY0000001': { requests_used: 5, tokens_used: 100 },
    });

    expect(secondState.reconcile(new Set(['p1:KEY0000001']), {})).toBe(true);
    expect(secondState.get('p1:KEY0000002')).toBeUndefined();
    expect(await secondUsage.load()).not.toHaveProperty('p1:KEY0000002');

    first.close();
    second.close();
  });

  it('RuntimeConfigManager 可直接使用 SQLite 仓储并保留导入用量', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    writeJson(configPath, runtimeConfig(3));
    writeJson(path.join(tempDir, 'runtime_usage.json'), {
      version: 2,
      usage: { 'provider-a:STABLE0001': { requests_used: 2, tokens_used: 40 } },
    });
    const repository = new SqliteConfigRepository(path.join(tempDir, 'runtime.db'), {
      legacyConfigPath: configPath,
    });
    const manager = new RuntimeConfigManager(repository);

    await manager.init();
    const resolved = manager.resolveModel('client-model');
    expect(resolved.rotator.getQuotaSnapshot('placeholder-key').usage).toEqual({
      requests_used: 2,
      tokens_used: 40,
    });
    expect(resolved.route.route_id).toBe('ROUTESTBL1');
    await manager.shutdown();
  });

  it('检测到未来 schema 版本时拒绝降级打开', () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const repository = new SqliteConfigRepository(dbPath);
    repository.close();
    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(99, Date.now());
    db.close();

    expect(() => new SqliteConfigRepository(dbPath)).toThrow('SQLite schema 版本过新：99');
  });
});

function emptyConfig(revision: number) {
  return {
    revision,
    providers: [],
    models: [],
    default_client_model: null,
    proxy_auth_token: null,
  };
}

function runtimeConfig(revision: number) {
  return {
    revision,
    providers: [{
      provider_id: 'provider-a',
      provider_type: 'openai_compatible' as const,
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
  };
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
