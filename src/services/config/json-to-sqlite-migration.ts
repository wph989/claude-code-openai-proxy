import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import type { KeyUsage, RuntimeConfig } from '../../types/runtime-config.js';
import { isPlainObject } from '../../utils/guards.js';
import type { KeyRuntimeRecord } from '../../types/runtime-config.js';
import { stripRuntimeFromConfig, validateRuntimeConfig } from './normalizer.js';
import type { ConfigHistoryRecord } from './repository.js';
import { SqliteConfigRepository, type SqliteImportBundle } from './sqlite-config-repository.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const LEGACY_STATE_VERSION = 2;
const LEGACY_USAGE_VERSION = 2;
const LEGACY_HISTORY_VERSION = 1;

export interface JsonToSqliteMigrationOptions {
  configPath: string;
  sqlitePath: string;
  dryRun?: boolean;
}

export interface AutoJsonToSqliteMigrationOptions {
  configPath?: string | null;
  sqlitePath: string;
  sourceRequired?: boolean;
}

export interface JsonToSqliteMigrationResult {
  dryRun: boolean;
  sqlitePath: string;
  sourceFiles: string[];
  revision: number;
  providerCount: number;
  routeCount: number;
  keyCount: number;
  stateCount: number;
  usageCount: number;
  historyCount: number;
}

export type AutoJsonToSqliteMigrationResult =
  | { status: 'disabled'; sqlitePath: string }
  | { status: 'skipped'; sqlitePath: string; revision: number }
  | { status: 'migrated'; result: JsonToSqliteMigrationResult };

export interface SqliteTargetStatus {
  initialized: boolean;
  revision?: number;
}

interface OptionalJson {
  exists: boolean;
  value?: unknown;
}

export async function migrateJsonToSqlite(
  options: JsonToSqliteMigrationOptions,
): Promise<JsonToSqliteMigrationResult> {
  const configPath = path.resolve(options.configPath);
  const sqlitePath = path.resolve(options.sqlitePath);
  if (configPath === sqlitePath) throw new Error('JSON 源文件与 SQLite 目标文件不能是同一路径。');

  await assertUninitializedTarget(sqlitePath);
  const loaded = await loadLegacyBundle(configPath);

  if (!options.dryRun) {
    const repository = new SqliteConfigRepository(sqlitePath);
    try {
      repository.importBundle(loaded.bundle);
    } finally {
      repository.close();
    }
  }

  const config = loaded.bundle.config;
  return {
    dryRun: options.dryRun === true,
    sqlitePath,
    sourceFiles: loaded.sourceFiles,
    revision: config.revision ?? 1,
    providerCount: config.providers.length,
    routeCount: config.models.length,
    keyCount: config.providers.reduce(
      (total, provider) => total + (Array.isArray(provider.api_key) ? provider.api_key.length : 0),
      0,
    ),
    stateCount: Object.keys(loaded.bundle.states).length,
    usageCount: Object.keys(loaded.bundle.usage).length,
    historyCount: loaded.bundle.history?.length ?? 0,
  };
}

/**
 * 启动前只在目标库尚未初始化时导入旧 JSON；已初始化时跳过源文件读取，避免
 * 旧配置被误认为仍是运行时真相，也避免多进程启动时反复解析敏感文件。
 */
export async function autoMigrateJsonToSqlite(
  options: AutoJsonToSqliteMigrationOptions,
): Promise<AutoJsonToSqliteMigrationResult> {
  const sqlitePath = path.resolve(options.sqlitePath);
  const configPath = options.configPath?.trim();
  if (!configPath) return { status: 'disabled', sqlitePath };

  const resolvedConfigPath = path.resolve(configPath);
  if (resolvedConfigPath === sqlitePath) {
    throw new Error('JSON 源文件与 SQLite 目标文件不能是同一路径。');
  }

  const target = await inspectSqliteTarget(sqlitePath);
  if (target.initialized) {
    return { status: 'skipped', sqlitePath, revision: target.revision ?? 1 };
  }

  if (options.sourceRequired !== true && !(await isRegularFile(resolvedConfigPath))) {
    return { status: 'disabled', sqlitePath };
  }

  const result = await migrateJsonToSqlite({
    configPath: resolvedConfigPath,
    sqlitePath,
  });
  return { status: 'migrated', result };
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function loadLegacyBundle(configPath: string): Promise<{
  bundle: SqliteImportBundle;
  sourceFiles: string[];
}> {
  const rawConfig = await readRequiredJson(configPath, '主配置');
  const normalized = normalizeConfig(rawConfig, '主配置');
  const { config, runtimeByProvider } = stripRuntimeFromConfig(normalized);
  const directory = path.dirname(configPath);
  const statePath = path.join(directory, 'runtime_state.json');
  const historyPath = path.join(directory, 'runtime_history.json');
  const usagePath = resolveLegacyUsagePath(rawConfig, directory);
  const [stateFile, usageFile, historyFile] = await Promise.all([
    readOptionalJson(statePath, 'Key 状态'),
    readOptionalJson(usagePath, '用量'),
    readOptionalJson(historyPath, '配置历史'),
  ]);

  const embeddedStates = Object.fromEntries(
    Object.entries(runtimeByProvider).flatMap(([providerId, records]) => (
      Object.entries(records).map(([keyId, state]) => [`${providerId}:${keyId}`, state])
    )),
  );
  const states = stateFile.exists
    ? { ...embeddedStates, ...parseStateFile(stateFile.value, statePath) }
    : embeddedStates;
  restoreAutoDisabledConfig(config, states);
  const usage = usageFile.exists ? parseUsageFile(usageFile.value, usagePath) : {};
  const history = historyFile.exists
    ? parseHistoryFile(historyFile.value, historyPath, config.revision ?? 1)
    : [];

  const sourceFiles = [configPath];
  if (stateFile.exists) sourceFiles.push(statePath);
  if (usageFile.exists) sourceFiles.push(usagePath);
  if (historyFile.exists) sourceFiles.push(historyPath);
  return { bundle: { config, states, usage, history }, sourceFiles };
}

function restoreAutoDisabledConfig(
  config: RuntimeConfig,
  states: Record<string, KeyRuntimeRecord>,
): void {
  for (const provider of config.providers) {
    if (!Array.isArray(provider.api_key)) continue;
    for (const key of provider.api_key) {
      const state = states[`${provider.provider_id}:${key.id}`];
      if (state?.auto_disabled_at != null && key.enabled === false) {
        // 旧后端把自动禁用误混进配置字段；SQLite 必须恢复配置意图，临时禁用由状态行承载。
        key.enabled = true;
      }
    }
  }
}

function normalizeConfig(value: unknown, label: string): RuntimeConfig {
  if (!isPlainObject(value) || !Array.isArray(value.providers) || !Array.isArray(value.models)) {
    throw new Error(`${label}必须是包含 providers 和 models 数组的 JSON 对象。`);
  }
  try {
    return validateRuntimeConfig(value as unknown as RuntimeConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}校验失败：${message}`);
  }
}

function resolveLegacyUsagePath(rawConfig: unknown, directory: string): string {
  let hint = 'runtime_usage.json';
  if (isPlainObject(rawConfig)
    && isPlainObject(rawConfig.anti_ban)
    && isPlainObject(rawConfig.anti_ban.quota)
    && typeof rawConfig.anti_ban.quota.usage_file === 'string'
    && rawConfig.anti_ban.quota.usage_file.trim()) {
    hint = rawConfig.anti_ban.quota.usage_file.trim();
  }
  return path.isAbsolute(hint) ? path.resolve(hint) : path.resolve(directory, hint);
}

function parseStateFile(value: unknown, filePath: string): Record<string, KeyRuntimeRecord> {
  if (!isPlainObject(value) || value.version !== LEGACY_STATE_VERSION || !isPlainObject(value.states)) {
    throw new Error(`${filePath} 必须是 version=${LEGACY_STATE_VERSION} 的 Key 状态文件。`);
  }
  return Object.fromEntries(Object.entries(value.states).map(([compositeKey, record]) => {
    assertCompositeKey(compositeKey, filePath);
    return [compositeKey, parseStateRecord(record, `${filePath}:${compositeKey}`)];
  }));
}

function parseStateRecord(value: unknown, label: string): KeyRuntimeRecord {
  if (!isPlainObject(value)) throw new Error(`${label} 必须是对象。`);
  const allowed = new Set([
    'enabled', 'error_count', 'disabled_at', 'last_error_at', 'last_error_message', 'auto_disabled_at',
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} 包含无法迁移的字段：${unknown.join(', ')}。`);
  const record: KeyRuntimeRecord = {};
  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') throw new Error(`${label}.enabled 必须是布尔值。`);
    record.enabled = value.enabled;
  }
  if ('error_count' in value) record.error_count = readCounter(value.error_count, `${label}.error_count`);
  if ('disabled_at' in value) record.disabled_at = readNullableTimestamp(value.disabled_at, `${label}.disabled_at`);
  if ('last_error_at' in value) record.last_error_at = readNullableTimestamp(value.last_error_at, `${label}.last_error_at`);
  if ('auto_disabled_at' in value) {
    record.auto_disabled_at = readNullableTimestamp(value.auto_disabled_at, `${label}.auto_disabled_at`);
  }
  if ('last_error_message' in value) {
    if (value.last_error_message !== null && typeof value.last_error_message !== 'string') {
      throw new Error(`${label}.last_error_message 必须是字符串或 null。`);
    }
    record.last_error_message = value.last_error_message;
  }
  if (record.enabled === undefined && record.auto_disabled_at != null) {
    // 旧 JSON 后端用 auto_disabled_at 表达自动禁用，迁入共享协调器时必须显式落 enabled=0。
    record.enabled = false;
  }
  return record;
}

function parseUsageFile(value: unknown, filePath: string): Record<string, KeyUsage> {
  if (!isPlainObject(value) || value.version !== LEGACY_USAGE_VERSION || !isPlainObject(value.usage)) {
    throw new Error(`${filePath} 必须是 version=${LEGACY_USAGE_VERSION} 的用量文件。`);
  }
  return Object.fromEntries(Object.entries(value.usage).map(([compositeKey, usage]) => {
    assertCompositeKey(compositeKey, filePath);
    if (!isPlainObject(usage)) throw new Error(`${filePath}:${compositeKey} 必须是对象。`);
    const parsed: KeyUsage = {
      requests_used: readCounter(usage.requests_used, `${filePath}:${compositeKey}.requests_used`),
      tokens_used: readCounter(usage.tokens_used, `${filePath}:${compositeKey}.tokens_used`),
    };
    if ('input_tokens_used' in usage) {
      parsed.input_tokens_used = readCounter(usage.input_tokens_used, `${filePath}:${compositeKey}.input_tokens_used`);
    }
    if ('output_tokens_used' in usage) {
      parsed.output_tokens_used = readCounter(usage.output_tokens_used, `${filePath}:${compositeKey}.output_tokens_used`);
    }
    if ('cost_usd' in usage) parsed.cost_usd = readMoney(usage.cost_usd, `${filePath}:${compositeKey}.cost_usd`);
    return [compositeKey, parsed];
  }));
}

function parseHistoryFile(
  value: unknown,
  filePath: string,
  currentRevision: number,
): ConfigHistoryRecord[] {
  if (!isPlainObject(value) || value.version !== LEGACY_HISTORY_VERSION || !Array.isArray(value.entries)) {
    throw new Error(`${filePath} 必须是 version=${LEGACY_HISTORY_VERSION} 的配置历史文件。`);
  }
  const seen = new Set<number>();
  return value.entries.map((rawEntry, index) => {
    const label = `${filePath}:entries[${index}]`;
    if (!isPlainObject(rawEntry)) throw new Error(`${label} 必须是对象。`);
    const revision = readPositiveInteger(rawEntry.revision, `${label}.revision`);
    if (revision > currentRevision) throw new Error(`${label}.revision 不能大于当前配置版本。`);
    if (seen.has(revision)) throw new Error(`${filePath} 包含重复 revision=${revision}。`);
    seen.add(revision);
    const createdAt = readPositiveInteger(rawEntry.createdAt, `${label}.createdAt`);
    if (!isPlainObject(rawEntry.config)) throw new Error(`${label}.config 必须是对象。`);
    const declaredRevision = rawEntry.config.revision;
    if (declaredRevision !== undefined && Number(declaredRevision) !== revision) {
      throw new Error(`${label}.config.revision 与历史 revision 不一致。`);
    }
    const normalized = normalizeConfig({ ...rawEntry.config, revision }, `${label}.config`);
    return {
      revision,
      createdAt,
      config: stripRuntimeFromConfig(normalized).config,
    };
  });
}

async function readRequiredJson(filePath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) throw new Error(`${label}不存在：${filePath}`);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}读取失败：${filePath}（${message}）`);
  }
}

async function readOptionalJson(filePath: string, label: string): Promise<OptionalJson> {
  try {
    return { exists: true, value: JSON.parse(await readFile(filePath, 'utf8')) as unknown };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { exists: false };
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}文件读取失败：${filePath}（${message}）`);
  }
}

async function assertUninitializedTarget(sqlitePath: string): Promise<void> {
  const status = await inspectSqliteTarget(sqlitePath);
  if (status.initialized) {
    throw new Error(`SQLite 目标库已初始化（revision=${status.revision ?? 1}），拒绝迁移。`);
  }
}

async function inspectSqliteTarget(sqlitePath: string): Promise<SqliteTargetStatus> {
  try {
    const info = await stat(sqlitePath);
    if (!info.isFile()) throw new Error(`SQLite 目标不是文件：${sqlitePath}`);
    if (info.size === 0) return { initialized: false };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { initialized: false };
    throw error;
  }

  let db: NodeDatabaseSync;
  try {
    db = new DatabaseSync(sqlitePath, { readOnly: true });
  } catch {
    throw new Error(`SQLite 目标不是有效数据库：${sqlitePath}`);
  }
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>;
    if (tables.length === 0) return { initialized: false };
    const names = new Set(tables.map((row) => row.name));
    if (!names.has('schema_migrations') || !names.has('app_config')) {
      throw new Error(`SQLite 目标包含非 CCOP 数据，拒绝迁移：${sqlitePath}`);
    }
    const existing = db.prepare('SELECT revision FROM app_config WHERE singleton_id = 1').get() as
      | { revision: number }
      | undefined;
    if (existing) {
      return { initialized: true, revision: existing.revision };
    }
    return { initialized: false };
  } finally {
    db.close();
  }
}

function assertCompositeKey(value: string, label: string): void {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${label} 包含无效的 Key 复合 ID。`);
  }
}

function readCounter(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} 必须是非负整数。`);
  return parsed;
}

function readPositiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数。`);
  return parsed;
}

function readNullableTimestamp(value: unknown, label: string): number | null {
  if (value === null) return null;
  return readCounter(value, label);
}

function readMoney(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} 必须是非负数字。`);
  return parsed;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}
