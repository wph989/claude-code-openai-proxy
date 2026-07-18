import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigConflictError } from '../src/errors.js';
import { RuntimeConfigManager } from '../src/services/runtime-config.js';
import { createApp } from '../src/server.js';
import { ProviderHealthRegistry } from '../src/services/provider-health.js';
import type { SharedKeyCandidate } from '../src/services/key-runtime-coordinator.js';
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
      expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(
        Array.from({ length: SQLITE_SCHEMA_VERSION }, (_, index) => ({ version: index + 1 })),
      );
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

  it('两个连接共享事务 lease，压力获取不会突破 max_concurrent', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const first = new SqliteConfigRepository(dbPath);
    const second = new SqliteConfigRepository(dbPath);
    await first.ensureDefaultConfig(() => emptyConfig(1));
    const coordinators = [first.createKeyRuntimeCoordinator(), second.createKeyRuntimeCoordinator()];
    const candidate = sharedCandidate({ maxConcurrent: 2 });

    const leases = Array.from({ length: 100 }, (_, index) => (
      coordinators[index % coordinators.length].tryAcquire([candidate], 1_000, 500).lease
    )).filter((lease) => lease !== null);

    expect(leases).toHaveLength(2);
    expect(new Set(leases.map((lease) => lease.leaseId)).size).toBe(2);
    expect(coordinators[0].snapshot(candidate, 1_001).activeLeases).toBe(2);

    coordinators[0].release(leases[0].leaseId);
    // release 必须幂等，响应清理与 finally 同时触发时不能误删其他请求的 lease。
    coordinators[1].release(leases[0].leaseId);
    expect(coordinators[1].tryAcquire([candidate], 1_002, 500).lease).not.toBeNull();

    first.close();
    second.close();
  });

  it('Worker 未 release 时由 TTL 回收 lease，Key 不会永久占满', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const crashedWorker = new SqliteConfigRepository(dbPath);
    const survivor = new SqliteConfigRepository(dbPath);
    await crashedWorker.ensureDefaultConfig(() => emptyConfig(1));
    const crashedCoordinator = crashedWorker.createKeyRuntimeCoordinator();
    const survivorCoordinator = survivor.createKeyRuntimeCoordinator();
    const candidate = sharedCandidate({ maxConcurrent: 1 });

    expect(crashedCoordinator.tryAcquire([candidate], 5_000, 50).lease).not.toBeNull();
    const blocked = survivorCoordinator.tryAcquire([candidate], 5_049, 50);
    expect(blocked.lease).toBeNull();
    expect(blocked.nextAvailableAt).toBe(5_050);

    const recovered = survivorCoordinator.tryAcquire([candidate], 5_050, 50);
    expect(recovered.lease).not.toBeNull();
    expect(recovered.snapshot?.activeLeases).toBe(1);

    crashedWorker.close();
    survivor.close();
  });

  it('错误、自动恢复和用量增量在两个连接间保持权威一致', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const first = new SqliteConfigRepository(dbPath);
    const second = new SqliteConfigRepository(dbPath);
    await first.ensureDefaultConfig(() => emptyConfig(1));
    const firstCoordinator = first.createKeyRuntimeCoordinator();
    const secondCoordinator = second.createKeyRuntimeCoordinator();
    const candidate = sharedCandidate({
      autoRecoverMs: 50,
      quota: { max_requests: 3, soft_stop_threshold: 1 },
    });

    firstCoordinator.markError(candidate, {
      now: 10_000,
      message: 'temporary',
      category: 'transient',
      autoDisable: true,
      maxErrors: 2,
    });
    expect(secondCoordinator.snapshot(candidate, 10_001)).toMatchObject({
      enabled: true,
      errorCount: 1,
    });
    secondCoordinator.markError(candidate, {
      now: 10_002,
      message: 'temporary again',
      category: 'network',
      autoDisable: true,
      maxErrors: 2,
    });
    expect(firstCoordinator.snapshot(candidate, 10_003)).toMatchObject({
      enabled: false,
      errorCount: 2,
      autoDisabledAt: 10_002,
    });
    expect(firstCoordinator.snapshot(candidate, 10_052)).toMatchObject({
      enabled: true,
      errorCount: 0,
      autoDisabledAt: null,
    });

    firstCoordinator.recordUsage(candidate, { requests: 1, tokens: 10 }, 10_053);
    const usage = secondCoordinator.recordUsage(candidate, { requests: 2, tokens: 20 }, 10_054);
    expect(usage.usage).toEqual({ requests_used: 3, tokens_used: 30 });
    expect(usage.quotaBlocked).toBe(true);
    expect(firstCoordinator.snapshot(candidate, 10_055).usage).toEqual(usage.usage);

    first.close();
    second.close();
  });

  it('Provider 熔断和半开探测权跨连接共享，崩溃探测可按 TTL 接管', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const first = new SqliteConfigRepository(dbPath);
    const second = new SqliteConfigRepository(dbPath);
    await first.ensureDefaultConfig(() => emptyConfig(1));
    const firstHealth = new ProviderHealthRegistry(
      first.createProviderCircuitCoordinator(),
      { probeLeaseTtlMs: 50 },
    );
    const secondHealth = new ProviderHealthRegistry(
      second.createProviderCircuitCoordinator(),
      { probeLeaseTtlMs: 50 },
    );
    const circuitConfig = { failure_threshold: 1, recovery_seconds: 1 };
    firstHealth.configure('provider-a', circuitConfig);
    secondHealth.configure('provider-a', circuitConfig);

    const initial = firstHealth.acquire('provider-a', 0)!;
    firstHealth.recordFailure('provider-a', 'network', initial, 0);
    expect(secondHealth.snapshot('provider-a', 500)).toEqual({
      state: 'open',
      consecutiveFailures: 1,
      openUntil: 1_000,
    });
    expect(secondHealth.acquire('provider-a', 999)).toBeNull();

    const crashedProbe = firstHealth.acquire('provider-a', 1_000)!;
    expect(crashedProbe.probe).toBe(true);
    expect(secondHealth.acquire('provider-a', 1_049)).toBeNull();
    const takeover = secondHealth.acquire('provider-a', 1_050)!;
    expect(takeover.probe).toBe(true);
    secondHealth.recordSuccess('provider-a', takeover, 1_051);
    expect(firstHealth.snapshot('provider-a', 1_052)).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
      openUntil: null,
    });

    first.close();
    second.close();
  });

  it('费用预算按输入输出单价跨连接原子累计', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const first = new SqliteConfigRepository(dbPath);
    const second = new SqliteConfigRepository(dbPath);
    await first.ensureDefaultConfig(() => emptyConfig(1));
    const firstCoordinator = first.createKeyRuntimeCoordinator();
    const secondCoordinator = second.createKeyRuntimeCoordinator();
    const candidate = sharedCandidate({
      quota: {
        max_requests: null,
        max_tokens: null,
        max_cost_usd: 0.0011,
        input_cost_per_million: 10,
        output_cost_per_million: 30,
        soft_stop_threshold: 1,
      },
    });

    firstCoordinator.recordUsage(candidate, {
      requests: 1,
      tokens: 50,
      inputTokens: 50,
      outputTokens: 0,
    }, 20_000);
    const snapshot = secondCoordinator.recordUsage(candidate, {
      requests: 1,
      tokens: 20,
      inputTokens: 0,
      outputTokens: 20,
    }, 20_001);

    expect(snapshot.usage).toEqual({
      requests_used: 2,
      tokens_used: 70,
      input_tokens_used: 50,
      output_tokens_used: 20,
      cost_usd: 0.0011,
    });
    expect(snapshot.quotaBlocked).toBe(true);
    expect(firstCoordinator.snapshot(candidate, 20_002).quotaReason).toContain('费用');

    first.close();
    second.close();
  });

  it('两个 RuntimeConfigManager 共享 busy 状态和原子用量', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const firstRepository = new SqliteConfigRepository(dbPath);
    const secondRepository = new SqliteConfigRepository(dbPath);
    await firstRepository.ensureDefaultConfig(() => runtimeConfig(1));
    const first = new RuntimeConfigManager(firstRepository);
    const second = new RuntimeConfigManager(secondRepository);
    await first.init();
    await second.init();

    const firstRotator = first.resolveModel('client-model').rotator;
    const secondRotator = second.resolveModel('client-model').rotator;
    const lease = await firstRotator.acquire({ deadline: Date.now() + 500 });
    expect(secondRotator.getKeyStatuses()[0]).toMatchObject({
      status: 'busy',
      active_requests: 1,
    });

    firstRotator.recordUsage(lease.key, 1, 10);
    secondRotator.recordUsage('placeholder-key', 2, 20);
    expect(firstRotator.getQuotaSnapshot('placeholder-key').usage).toEqual({
      requests_used: 3,
      tokens_used: 30,
    });
    firstRotator.release(lease);
    expect(secondRotator.getKeyStatuses()[0].active_requests).toBe(0);

    await first.shutdown();
    await second.shutdown();
  });

  it('createApp 按显式存储选项创建 SQLite 仓储并导入 JSON', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    const dbPath = path.join(tempDir, 'runtime.db');
    writeJson(configPath, runtimeConfig(4));
    const app = await createApp(configPath, {
      storageBackend: 'sqlite',
      sqlitePath: dbPath,
    });
    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(app.runtimeConfigManager.getRevision()).toBe(4);
      expect(app.runtimeConfigManager.resolveModel('client-model').provider.provider_id).toBe('provider-a');
    } finally {
      await app.runtimeConfigManager.shutdown();
      await app.close();
    }
  });

  it('两个管理器同时写相同 revision 时仅一个成功，失败方重载权威配置', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const firstRepository = new SqliteConfigRepository(dbPath);
    const secondRepository = new SqliteConfigRepository(dbPath);
    await firstRepository.ensureDefaultConfig(() => runtimeConfig(1));
    const first = new RuntimeConfigManager(firstRepository);
    const second = new RuntimeConfigManager(secondRepository);
    await first.init();
    await second.init();
    const firstUpdate = first.getConfig();
    const secondUpdate = second.getConfig();
    firstUpdate.models[0].description = 'first-writer';
    secondUpdate.models[0].description = 'second-writer';

    try {
      const results = await Promise.allSettled([
        first.saveConfig(firstUpdate, 1),
        second.saveConfig(secondUpdate, 1),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({ reason: { currentRevision: 2 } });

      const persisted = await firstRepository.loadConfig();
      expect(persisted.revision).toBe(2);
      expect(first.getRevision()).toBe(2);
      expect(second.getRevision()).toBe(2);
      expect(first.getConfig().models[0].description).toBe(persisted.models[0].description);
      expect(second.getConfig().models[0].description).toBe(persisted.models[0].description);
    } finally {
      await first.shutdown();
      await second.shutdown();
    }
  });

  it('旧 Worker 在下一次 HTTP 请求前按 revision 刷新配置', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const firstRepository = new SqliteConfigRepository(dbPath);
    const secondRepository = new SqliteConfigRepository(dbPath);
    await firstRepository.ensureDefaultConfig(() => runtimeConfig(1));
    const firstApp = await createApp('unused.json', { configRepository: firstRepository });
    const secondApp = await createApp('unused.json', { configRepository: secondRepository });
    try {
      const updated = firstApp.runtimeConfigManager.getConfig();
      updated.models[0].upstream_model = 'new-upstream-model';
      await firstApp.runtimeConfigManager.saveConfig(updated, 1);
      expect(secondApp.runtimeConfigManager.getRevision()).toBe(1);

      const response = await secondApp.inject({ method: 'GET', url: '/livez' });
      expect(response.statusCode).toBe(200);
      expect(secondApp.runtimeConfigManager.getRevision()).toBe(2);
      expect(secondApp.runtimeConfigManager.resolveModel('client-model').route.upstream_model)
        .toBe('new-upstream-model');
    } finally {
      await firstApp.runtimeConfigManager.shutdown();
      await secondApp.runtimeConfigManager.shutdown();
      await firstApp.close();
      await secondApp.close();
    }
  });

  it('配置历史接口只返回脱敏元数据，回滚生成新的单调 revision', async () => {
    const dbPath = path.join(tempDir, 'runtime.db');
    const repository = new SqliteConfigRepository(dbPath);
    await repository.ensureDefaultConfig(() => runtimeConfig(1));
    const manager = new RuntimeConfigManager(repository);
    await manager.init();
    try {
      const updated = manager.getConfig();
      updated.models[0].description = 'changed';
      await manager.saveConfig(updated, 1);

      const history = await manager.listConfigHistory();
      expect(history.map((entry) => entry.revision)).toEqual([2, 1]);
      expect(history[0]).toMatchObject({
        current: true,
        summary: { provider_count: 1, model_count: 1 },
      });
      expect(history[1].rollback_changes).toContainEqual(expect.objectContaining({
        scope: 'route',
        action: 'update',
        fields: expect.arrayContaining(['description']),
      }));
      expect(JSON.stringify(history)).not.toContain('placeholder-key');
      expect(JSON.stringify(history)).not.toContain('config_json');

      await manager.rollbackConfig(1, 2);
      expect(manager.getRevision()).toBe(3);
      expect(manager.getConfig().models[0].description).toBe('');
      expect((await repository.listConfigHistory(10)).map((entry) => entry.revision))
        .toEqual([3, 2, 1]);
    } finally {
      await manager.shutdown();
    }
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

function sharedCandidate(overrides: Partial<SharedKeyCandidate> = {}): SharedKeyCandidate {
  return {
    compositeKey: 'provider-a:STABLE0001',
    configuredEnabled: true,
    maxConcurrent: 1,
    minIntervalMs: 0,
    autoRecoverMs: 0,
    quota: null,
    ...overrides,
  };
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
