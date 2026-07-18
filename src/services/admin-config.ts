import { RuntimeConfigError } from '../errors.js';
import type {
  ApiKeyEntry,
  KeyQuotaConfig,
  KeyUsage,
  ModelRouteConfig,
  ProviderConfig,
  RuntimeConfig,
} from '../types/runtime-config.js';
import type { KeyErrorCategory, KeyRuntimeStatus } from './api-key-rotator.js';

export interface AdminKeyView {
  id: string;
  key_mask: string;
  source: 'config' | 'environment';
  enabled: boolean;
  error_count: number;
  disabled_at: number | null;
  last_error_at: number | null;
  last_error_message: string | null;
  auto_disabled_at: number | null;
  note?: string;
  quota?: KeyQuotaConfig | null;
  status?: 'available' | 'delayed' | 'disabled' | 'busy';
  active_requests?: number;
  next_available_at?: number | null;
  last_error_category?: KeyErrorCategory;
  disabled_reason?: string | null;
  usage?: KeyUsage;
  quota_blocked?: boolean;
  quota_reason?: string | null;
}

export type AdminProviderView = Omit<ProviderConfig, 'api_key' | 'headers'> & {
  api_key: AdminKeyView[];
  /** 敏感 Header 的值固定为 null，表示“已配置但不下发”。 */
  headers: Record<string, string | null>;
};

export type AdminRuntimeConfigView = Omit<RuntimeConfig, 'providers' | 'proxy_auth_token'> & {
  providers: AdminProviderView[];
};

export interface AdminConfigChange {
  scope: 'global' | 'provider' | 'route';
  action: 'add' | 'update' | 'delete';
  target: string;
  fields: string[];
}

export interface AdminConfigChangePreview {
  has_changes: boolean;
  changes: AdminConfigChange[];
}

/**
 * Header 名称由用户自由配置，因此在服务端按语义识别敏感项。
 * 脱敏必须发生在响应 DTO 边界，不能依赖浏览器收到明文后再替换。
 */
export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase().replace(/_/g, '-');
  return normalized === 'authorization'
    || normalized === 'proxy-authorization'
    || normalized.includes('api-key')
    || normalized.includes('apikey')
    || /(^|-)(token|secret|password)(-|$)/.test(normalized);
}

export function maskKey(key: string): string {
  const suffix = key.length > 4 ? key.slice(-4) : '';
  return suffix ? `********${suffix}` : '********';
}

export function toAdminKeyView(
  entry: ApiKeyEntry | KeyRuntimeStatus,
  source: 'config' | 'environment' = 'config',
): AdminKeyView {
  const runtime = entry as Partial<KeyRuntimeStatus>;
  return {
    id: entry.id,
    key_mask: maskKey(entry.key),
    source,
    enabled: entry.enabled,
    error_count: entry.error_count,
    disabled_at: entry.disabled_at,
    last_error_at: entry.last_error_at,
    last_error_message: redactDiagnostic(entry.last_error_message, entry.key),
    auto_disabled_at: entry.auto_disabled_at,
    ...(entry.note ? { note: entry.note } : {}),
    ...(entry.quota !== undefined ? { quota: entry.quota } : {}),
    ...(runtime.status ? { status: runtime.status } : {}),
    ...(runtime.active_requests !== undefined ? { active_requests: runtime.active_requests } : {}),
    ...(runtime.next_available_at !== undefined ? { next_available_at: runtime.next_available_at } : {}),
    ...(runtime.last_error_category !== undefined ? { last_error_category: runtime.last_error_category } : {}),
    ...(runtime.disabled_reason !== undefined
      ? { disabled_reason: redactDiagnostic(runtime.disabled_reason, entry.key) }
      : {}),
    ...(runtime.usage !== undefined ? { usage: runtime.usage } : {}),
    ...(runtime.quota_blocked !== undefined ? { quota_blocked: runtime.quota_blocked } : {}),
    ...(runtime.quota_reason !== undefined ? { quota_reason: runtime.quota_reason } : {}),
  };
}

export function buildAdminRuntimeConfigView(
  config: RuntimeConfig,
  keyStates: Record<string, KeyRuntimeStatus[]>,
): AdminRuntimeConfigView {
  const providers = config.providers.map((provider): AdminProviderView => ({
    ...provider,
    // 配置视图只列出可持久化 Key；环境变量 Key 只出现在 key_states，避免整体保存把环境变量秘密写回文件。
    api_key: (Array.isArray(provider.api_key) ? provider.api_key : []).map((entry) => {
      const status = (keyStates[provider.provider_id] || []).find((item) => item.id === entry.id);
      return toAdminKeyView(status || entry);
    }),
    headers: redactHeaders(provider.headers || {}),
  }));
  const { proxy_auth_token: _secret, ...safeConfig } = config;
  return { ...safeConfig, providers };
}

/**
 * 将脱敏管理 DTO 合并回服务端配置。null 的敏感 Header 表示保留原值；
 * Key 则只凭稳定 id 找回明文。这样普通保存请求无需携带既有秘密。
 */
export function mergeAdminConfigUpdate(current: RuntimeConfig, input: unknown): RuntimeConfig {
  if (!isRecord(input) || !Array.isArray(input.providers) || !Array.isArray(input.models)) {
    throw new RuntimeConfigError('管理端配置格式无效。');
  }

  const raw = structuredClone(input) as Record<string, unknown>;
  const keyById = new Map<string, ApiKeyEntry>();
  for (const provider of current.providers) {
    if (!Array.isArray(provider.api_key)) continue;
    for (const key of provider.api_key) keyById.set(key.id, key);
  }

  raw.providers = input.providers.map((candidate) => {
    if (!isRecord(candidate)) throw new RuntimeConfigError('供应商配置格式无效。');
    const provider = structuredClone(candidate);
    const providerId = typeof provider.provider_id === 'string' ? provider.provider_id : '';
    const previous = findPreviousProvider(current.providers, providerId, provider.api_key);

    provider.headers = mergeHeaders(previous?.headers || {}, provider.headers);
    if (Array.isArray(provider.api_key)) {
      provider.api_key = provider.api_key.map((candidateKey) => {
        if (!isRecord(candidateKey)) throw new RuntimeConfigError(`供应商 ${providerId} 的 Key 格式无效。`);
        const suppliedKey = typeof candidateKey.key === 'string' ? candidateKey.key.trim() : '';
        if (suppliedKey) return candidateKey;
        const id = typeof candidateKey.id === 'string' ? candidateKey.id.trim() : '';
        const existing = id ? keyById.get(id) : undefined;
        if (!existing) throw new RuntimeConfigError(`Key ${id || '<未知>'} 缺少可用的稳定 ID。`);
        const { key_mask: _mask, ...safeFields } = candidateKey;
        return { ...safeFields, key: existing.key };
      });
    } else if (provider.api_key === undefined && previous?.api_key !== undefined) {
      provider.api_key = structuredClone(previous.api_key);
    }
    return provider;
  });

  // Token 只能通过独立写接口轮换；整体配置保存永远沿用服务端现值。
  raw.proxy_auth_token = current.proxy_auth_token ?? null;
  raw.revision = current.revision ?? 1;
  return raw as unknown as RuntimeConfig;
}

export function buildConfigChangePreview(before: RuntimeConfig, after: RuntimeConfig): AdminConfigChangePreview {
  const changes: AdminConfigChange[] = [];
  const globalFields: Array<keyof RuntimeConfig> = ['default_client_model', 'key_max_errors', 'anti_ban'];
  const changedGlobals = globalFields.filter((field) => !same(before[field], after[field])).map(String);
  if (changedGlobals.length > 0) {
    changes.push({ scope: 'global', action: 'update', target: '全局配置', fields: changedGlobals });
  }

  diffResources(
    before.providers,
    after.providers,
    (provider) => provider.provider_id,
    ['provider_type', 'base_url', 'quota', 'api_key', 'api_key_env', 'key_rotation_strategy', 'auto_disable_on_error', 'auto_recover_minutes', 'timeout_seconds', 'stream_idle_timeout_seconds', 'enabled', 'headers', 'anti_ban', 'circuit_breaker', 'description'],
    'provider',
    changes,
  );
  diffResources(
    before.models,
    after.models,
    (route) => route.route_id || `${route.provider_id}:${route.client_model}:${route.upstream_model}`,
    ['client_model', 'provider_id', 'upstream_model', 'priority', 'weight', 'enabled', 'extra_body', 'description'],
    'route',
    changes,
  );
  return { has_changes: changes.length > 0, changes };
}

function redactHeaders(headers: Record<string, string>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    isSensitiveHeaderName(name) ? null : value,
  ]));
}

function redactDiagnostic(value: string | null | undefined, key: string): string | null {
  if (!value) return null;
  // 上游错误偶尔会回显鉴权内容；DTO 返回前再次清洗，避免状态接口绕过 Key 主字段脱敏。
  return value
    .split(key).join('[已脱敏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [已脱敏]');
}

function mergeHeaders(previous: Record<string, string>, input: unknown): Record<string, string> {
  if (input === undefined) return structuredClone(previous);
  if (!isRecord(input)) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === null && isSensitiveHeaderName(name)) {
      const oldName = Object.keys(previous).find((item) => item.toLowerCase() === name.toLowerCase());
      if (oldName) result[name] = previous[oldName];
      continue;
    }
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

function findPreviousProvider(providers: ProviderConfig[], providerId: string, keys: unknown): ProviderConfig | undefined {
  const direct = providers.find((provider) => provider.provider_id === providerId);
  if (direct) return direct;
  if (!Array.isArray(keys)) return undefined;
  const ids = new Set(keys.flatMap((key) => isRecord(key) && typeof key.id === 'string' ? [key.id] : []));
  if (ids.size === 0) return undefined;
  const matches = providers.filter((provider) => Array.isArray(provider.api_key)
    && provider.api_key.some((key) => ids.has(key.id)));
  return matches.length === 1 ? matches[0] : undefined;
}

function diffResources<T extends ProviderConfig | ModelRouteConfig>(
  before: T[],
  after: T[],
  identify: (item: T) => string,
  fields: Array<keyof T>,
  scope: 'provider' | 'route',
  changes: AdminConfigChange[],
): void {
  const oldById = new Map(before.map((item) => [identify(item), item]));
  const newById = new Map(after.map((item) => [identify(item), item]));
  for (const [id, item] of newById) {
    const old = oldById.get(id);
    if (!old) {
      changes.push({ scope, action: 'add', target: id, fields: [] });
      continue;
    }
    const changed = fields.filter((field) => !same(old[field], item[field])).map(String);
    if (changed.length > 0) changes.push({ scope, action: 'update', target: id, fields: changed });
  }
  for (const id of oldById.keys()) {
    if (!newById.has(id)) changes.push({ scope, action: 'delete', target: id, fields: [] });
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
