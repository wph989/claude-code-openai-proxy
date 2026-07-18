import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import { ConfigConflictError } from '../../errors.js';
import type { KeyUsage, RuntimeConfig } from '../../types/runtime-config.js';
import type { KeyRuntimeRecord } from '../key-state-store.js';
import type {
  ConfigRepository,
  KeyStateRepository,
  UsageRepository,
  UsageStoreInitOptions,
} from './repository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export const SQLITE_SCHEMA_VERSION = 1;

export interface SqliteConfigRepositoryOptions {
  /** 首次建库时导入的现有 JSON 配置；导入成功后原文件保持不动。 */
  legacyConfigPath?: string;
  busyTimeoutMs?: number;
}

interface ConfigRow {
  revision: number;
  config_json: string;
}

interface LegacyBundle {
  config: RuntimeConfig;
  states: Record<string, KeyRuntimeRecord>;
  usage: Record<string, KeyUsage>;
  imported: boolean;
}

const MIGRATIONS: Array<{ version: number; sql: string }> = [{
  version: 1,
  sql: `
    CREATE TABLE app_config (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      config_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE key_states (
      composite_key TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      enabled INTEGER,
      error_count INTEGER NOT NULL DEFAULT 0,
      disabled_at INTEGER,
      last_error_at INTEGER,
      last_error_message TEXT,
      auto_disabled_at INTEGER,
      next_available_at INTEGER,
      last_sent_at INTEGER,
      last_error_category TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX key_states_provider_idx ON key_states(provider_id);

    CREATE TABLE key_usage (
      composite_key TEXT PRIMARY KEY,
      requests_used INTEGER NOT NULL DEFAULT 0 CHECK (requests_used >= 0),
      tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE key_leases (
      lease_id TEXT PRIMARY KEY,
      composite_key TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (composite_key) REFERENCES key_states(composite_key) ON DELETE CASCADE
    );
    CREATE INDEX key_leases_key_expiry_idx ON key_leases(composite_key, expires_at);

    CREATE TABLE provider_circuits (
      provider_id TEXT PRIMARY KEY,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      open_until INTEGER NOT NULL DEFAULT 0,
      probe_lease_id TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `,
}];

/**
 * SQLite WAL 仓储。模块仅在选择 sqlite 后动态加载，因此默认 JSON 模式仍可运行在
 * 不提供 node:sqlite 的旧 Node 20；SQLite/多 Worker 模式要求 Node 22.5+。
 */
export class SqliteConfigRepository implements ConfigRepository {
  readonly storageKind = 'sqlite' as const;
  // lease 表已经建好，但在 Key 协调器接入前不能宣称具备共享运行态语义。
  readonly supportsSharedRuntime = false;
  readonly dbPath: string;
  private readonly db: NodeDatabaseSync;
  private readonly legacyConfigPath?: string;
  private closed = false;

  constructor(dbPath: string, options: SqliteConfigRepositoryOptions = {}) {
    this.dbPath = path.resolve(dbPath);
    this.legacyConfigPath = options.legacyConfigPath
      ? path.resolve(options.legacyConfigPath)
      : undefined;
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    try {
      const busyTimeoutMs = normalizeBusyTimeout(options.busyTimeoutMs);
      this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.applyMigrations();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  async loadConfig(): Promise<RuntimeConfig> {
    this.assertOpen();
    const row = this.db.prepare(
      'SELECT revision, config_json FROM app_config WHERE singleton_id = 1',
    ).get() as ConfigRow | undefined;
    if (!row) throw missingConfigError(this.dbPath);
    return JSON.parse(row.config_json) as RuntimeConfig;
  }

  async saveConfig(config: RuntimeConfig, expectedRevision?: number): Promise<void> {
    this.assertOpen();
    const revision = normalizeRevision(config.revision);
    const json = JSON.stringify(config);
    withImmediateTransaction(this.db, () => {
      const current = this.db.prepare(
        'SELECT revision, config_json FROM app_config WHERE singleton_id = 1',
      ).get() as ConfigRow | undefined;
      const currentRevision = current?.revision ?? 0;
      if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
        throw new ConfigConflictError(
          `配置已被其他 Worker 更新（当前 revision=${currentRevision}），请重新加载后再保存。`,
          currentRevision,
        );
      }
      if (current && revision < currentRevision) {
        throw new ConfigConflictError(
          `拒绝写入旧配置 revision=${revision}（当前 revision=${currentRevision}）。`,
          currentRevision,
        );
      }
      this.db.prepare(`
        INSERT INTO app_config(singleton_id, revision, config_json, updated_at)
        VALUES(1, ?, ?, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          revision = excluded.revision,
          config_json = excluded.config_json,
          updated_at = excluded.updated_at
      `).run(revision, json, Date.now());
    });
  }

  async getConfigRevision(): Promise<number | null> {
    this.assertOpen();
    const row = this.db.prepare(
      'SELECT revision FROM app_config WHERE singleton_id = 1',
    ).get() as { revision: number } | undefined;
    return row?.revision ?? null;
  }

  async ensureDefaultConfig(buildDefault: () => RuntimeConfig): Promise<RuntimeConfig> {
    this.assertOpen();
    const existing = await this.tryLoadConfig();
    if (existing) return existing;

    const bundle = await this.readLegacyBundle(buildDefault);
    return withImmediateTransaction(this.db, () => {
      const raced = this.db.prepare(
        'SELECT config_json FROM app_config WHERE singleton_id = 1',
      ).get() as { config_json: string } | undefined;
      if (raced) return JSON.parse(raced.config_json) as RuntimeConfig;

      const revision = normalizeRevision(bundle.config.revision);
      const config = { ...bundle.config, revision };
      this.db.prepare(`
        INSERT INTO app_config(singleton_id, revision, config_json, updated_at)
        VALUES(1, ?, ?, ?)
      `).run(revision, JSON.stringify(config), Date.now());
      for (const [compositeKey, state] of Object.entries(bundle.states)) {
        writeStatePatch(this.db, compositeKey, state);
      }
      for (const [compositeKey, usage] of Object.entries(bundle.usage)) {
        writeUsage(this.db, compositeKey, usage);
      }
      console.log(bundle.imported
        ? `[init] 已将 JSON 配置导入 SQLite: ${this.dbPath}`
        : `[init] SQLite 配置已创建: ${this.dbPath}`);
      return config;
    });
  }

  createKeyStateStore(): KeyStateRepository {
    this.assertOpen();
    return new SqliteKeyStateStore(this.db);
  }

  createUsageStore(_options: UsageStoreInitOptions): UsageRepository {
    this.assertOpen();
    return new SqliteUsageStore(this.db);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** 测试和诊断只读入口，不向业务层暴露可写 DatabaseSync。 */
  queryPragma(name: 'journal_mode' | 'foreign_keys' | 'user_version'): unknown {
    this.assertOpen();
    return this.db.prepare(`PRAGMA ${name}`).get();
  }

  private applyMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
        .map((row) => row.version),
    );
    const unknown = [...applied].filter((version) => version > SQLITE_SCHEMA_VERSION);
    if (unknown.length > 0) {
      throw new Error(`SQLite schema 版本过新：${Math.max(...unknown)}，当前仅支持 ${SQLITE_SCHEMA_VERSION}。`);
    }
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      withImmediateTransaction(this.db, () => {
        this.db.exec(migration.sql);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)')
          .run(migration.version, Date.now());
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }

  private async tryLoadConfig(): Promise<RuntimeConfig | null> {
    try {
      return await this.loadConfig();
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
  }

  private async readLegacyBundle(buildDefault: () => RuntimeConfig): Promise<LegacyBundle> {
    if (!this.legacyConfigPath) {
      return { config: buildDefault(), states: {}, usage: {}, imported: false };
    }
    const config = await readOptionalJson<RuntimeConfig>(this.legacyConfigPath);
    if (!config) return { config: buildDefault(), states: {}, usage: {}, imported: false };

    const dir = path.dirname(this.legacyConfigPath);
    const stateShape = await readOptionalJson<{
      version?: number;
      states?: Record<string, KeyRuntimeRecord>;
    }>(path.join(dir, 'runtime_state.json'));
    const usageHint = readUsageFileHint(config);
    const usageShape = await readOptionalJson<{
      version?: number;
      usage?: Record<string, KeyUsage>;
    }>(path.isAbsolute(usageHint) ? usageHint : path.join(dir, usageHint));
    return {
      config,
      states: stateShape?.version === 2 && stateShape.states ? stateShape.states : {},
      usage: usageShape?.version === 2 && usageShape.usage ? usageShape.usage : {},
      imported: true,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SQLite 仓储已关闭。');
  }
}

class SqliteKeyStateStore implements KeyStateRepository {
  constructor(private readonly db: NodeDatabaseSync) {}

  async load(): Promise<Record<string, KeyRuntimeRecord>> {
    return this.snapshot();
  }

  get(compositeKey: string): KeyRuntimeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM key_states WHERE composite_key = ?').get(compositeKey);
    return row ? stateFromRow(row as unknown as StateRow) : undefined;
  }

  snapshot(): Record<string, KeyRuntimeRecord> {
    const rows = this.db.prepare('SELECT * FROM key_states ORDER BY composite_key').all() as unknown as StateRow[];
    return Object.fromEntries(rows.map((row) => [row.composite_key, stateFromRow(row)]));
  }

  update(compositeKey: string, patch: KeyRuntimeRecord): void {
    withImmediateTransaction(this.db, () => writeStatePatch(this.db, compositeKey, patch));
  }

  bulkSet(records: Record<string, KeyRuntimeRecord>): void {
    withImmediateTransaction(this.db, () => {
      for (const [compositeKey, state] of Object.entries(records)) {
        writeStatePatch(this.db, compositeKey, state);
      }
    });
  }

  remove(compositeKey: string): void {
    this.db.prepare('DELETE FROM key_states WHERE composite_key = ?').run(compositeKey);
    this.db.prepare('DELETE FROM key_usage WHERE composite_key = ?').run(compositeKey);
  }

  removeByProvider(providerId: string): void {
    const keys = this.db.prepare('SELECT composite_key FROM key_states WHERE provider_id = ?')
      .all(providerId) as Array<{ composite_key: string }>;
    withImmediateTransaction(this.db, () => {
      for (const row of keys) {
        this.db.prepare('DELETE FROM key_usage WHERE composite_key = ?').run(row.composite_key);
      }
      this.db.prepare('DELETE FROM key_states WHERE provider_id = ?').run(providerId);
    });
  }

  reconcile(desired: Set<string>, defaults: KeyRuntimeRecord): boolean {
    const existing = new Set(
      (this.db.prepare('SELECT composite_key FROM key_states').all() as Array<{ composite_key: string }>)
        .map((row) => row.composite_key),
    );
    const removed = [...existing].filter((key) => !desired.has(key));
    const added = [...desired].filter((key) => !existing.has(key));
    if (removed.length === 0 && added.length === 0) return false;
    withImmediateTransaction(this.db, () => {
      for (const key of removed) {
        this.db.prepare('DELETE FROM key_usage WHERE composite_key = ?').run(key);
        this.db.prepare('DELETE FROM key_states WHERE composite_key = ?').run(key);
      }
      for (const key of added) writeStatePatch(this.db, key, defaults);
    });
    return true;
  }

  async forceFlush(): Promise<void> {
    // DatabaseSync 的每条写入在返回前已经提交；保留接口用于兼容 JSON 调用方。
  }
}

class SqliteUsageStore implements UsageRepository {
  constructor(private readonly db: NodeDatabaseSync) {}

  async load(): Promise<Record<string, KeyUsage>> {
    const rows = this.db.prepare(
      'SELECT composite_key, requests_used, tokens_used FROM key_usage ORDER BY composite_key',
    ).all() as Array<{ composite_key: string; requests_used: number; tokens_used: number }>;
    return Object.fromEntries(rows.map((row) => [row.composite_key, {
      requests_used: row.requests_used,
      tokens_used: row.tokens_used,
    }]));
  }

  update(compositeKey: string, usage: KeyUsage, _ratio: number): void {
    writeUsage(this.db, compositeKey, usage);
  }

  reconcile(desired: Set<string>): boolean {
    const existing = new Set(
      (this.db.prepare('SELECT composite_key FROM key_usage').all() as Array<{ composite_key: string }>)
        .map((row) => row.composite_key),
    );
    const removed = [...existing].filter((key) => !desired.has(key));
    const added = [...desired].filter((key) => !existing.has(key));
    if (removed.length === 0 && added.length === 0) return false;
    withImmediateTransaction(this.db, () => {
      for (const key of removed) this.db.prepare('DELETE FROM key_usage WHERE composite_key = ?').run(key);
      for (const key of added) writeUsage(this.db, key, { requests_used: 0, tokens_used: 0 });
    });
    return true;
  }

  async forceFlush(): Promise<void> {
    // 同步 SQLite 写入无需额外 flush。
  }
}

interface StateRow {
  composite_key: string;
  enabled: number | null;
  error_count: number;
  disabled_at: number | null;
  last_error_at: number | null;
  last_error_message: string | null;
  auto_disabled_at: number | null;
}

function stateFromRow(row: StateRow): KeyRuntimeRecord {
  return {
    ...(row.enabled == null ? {} : { enabled: row.enabled !== 0 }),
    error_count: row.error_count,
    disabled_at: row.disabled_at,
    last_error_at: row.last_error_at,
    last_error_message: row.last_error_message,
    auto_disabled_at: row.auto_disabled_at,
  };
}

function writeStatePatch(db: NodeDatabaseSync, compositeKey: string, patch: KeyRuntimeRecord): void {
  const { providerId, keyId } = splitCompositeKey(compositeKey);
  db.prepare(`
    INSERT OR IGNORE INTO key_states(
      composite_key, provider_id, key_id, error_count, updated_at
    ) VALUES(?, ?, ?, 0, ?)
  `).run(compositeKey, providerId, keyId, Date.now());

  const columns: string[] = [];
  const values: Array<string | number | null> = [];
  appendPatch(columns, values, 'enabled', patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0);
  appendPatch(columns, values, 'error_count', patch.error_count);
  appendPatch(columns, values, 'disabled_at', patch.disabled_at);
  appendPatch(columns, values, 'last_error_at', patch.last_error_at);
  appendPatch(columns, values, 'last_error_message', patch.last_error_message);
  appendPatch(columns, values, 'auto_disabled_at', patch.auto_disabled_at);
  if (columns.length === 0) return;
  columns.push('updated_at = ?');
  values.push(Date.now(), compositeKey);
  db.prepare(`UPDATE key_states SET ${columns.join(', ')} WHERE composite_key = ?`).run(...values);
}

function writeUsage(db: NodeDatabaseSync, compositeKey: string, usage: KeyUsage): void {
  db.prepare(`
    INSERT INTO key_usage(composite_key, requests_used, tokens_used, updated_at)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(composite_key) DO UPDATE SET
      requests_used = excluded.requests_used,
      tokens_used = excluded.tokens_used,
      updated_at = excluded.updated_at
  `).run(
    compositeKey,
    normalizeCounter(usage.requests_used),
    normalizeCounter(usage.tokens_used),
    Date.now(),
  );
}

function appendPatch(
  columns: string[],
  values: Array<string | number | null>,
  column: string,
  value: string | number | null | undefined,
): void {
  if (value === undefined) return;
  columns.push(`${column} = ?`);
  values.push(value);
}

function splitCompositeKey(compositeKey: string): { providerId: string; keyId: string } {
  const separator = compositeKey.indexOf(':');
  if (separator <= 0 || separator === compositeKey.length - 1) {
    throw new Error(`无效的 Key 复合 ID：${compositeKey}`);
  }
  return {
    providerId: compositeKey.slice(0, separator),
    keyId: compositeKey.slice(separator + 1),
  };
}

function withImmediateTransaction<T>(db: NodeDatabaseSync, callback: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 原错误优先。 */ }
    throw error;
  }
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as T;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function readUsageFileHint(config: RuntimeConfig): string {
  const hint = config.anti_ban?.quota?.usage_file;
  return typeof hint === 'string' && hint.trim() ? hint.trim() : 'runtime_usage.json';
}

function missingConfigError(dbPath: string): Error & { code: string } {
  return Object.assign(new Error(`SQLite 中尚未初始化配置：${dbPath}`), { code: 'ENOENT' });
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function normalizeRevision(value: unknown): number {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
}

function normalizeCounter(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeBusyTimeout(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 100 ? Math.min(parsed, 60_000) : 5_000;
}
