/**
 * 运行时配置的标准化与校验。
 *
 * 这些函数原本散在 src/models.ts 里，与类型混在一起。拆出来的目的：
 *   - 让 routes / services 引用类型时不必加载这套带正则、白名单的标准化代码
 *   - 便于针对 normalize/validate 单独写单元测试
 *   - 为后续 SQLite 实现配置仓库时复用同一套标准化流程
 */

import { nanoid } from '../../utils/nanoid.js';
import { isPlainObject } from '../../utils/guards.js';
import { normalizeRoutePriority, normalizeRouteWeight } from '../routing-policy.js';
import {
  KeyRotationStrategy,
  type AntiBanConfig,
  type ApiKeyEntry,
  type ApiKeyRuntimeFields,
  type CircuitBreakerConfig,
  type KeyQuotaConfig,
  type PersistedApiKey,
  type ProviderCapabilityOverrides,
  type RetryConfig,
  type RuntimeConfig,
  type RuntimeConfigSummary,
} from '../../types/runtime-config.js';

/**
 * 把"任意来源"的 RuntimeConfig 整成统一形态：
 *   - 字符串 trim
 *   - api_key 字段从字符串 / 数组 / 缺 id 等多种形态展开为 ApiKeyEntry[]
 *   - anti_ban 嵌套结构白名单保留
 *   - 数字字段范围校验
 *
 * 这里不抛错；validateRuntimeConfig 才会校验引用关系并抛错。
 */
export function normalizeRuntimeConfig(raw: RuntimeConfig): RuntimeConfig {
  const providers = (raw.providers || []).map((item) => {
    const providerType = normalizeProviderType(item.provider_type);
    return {
      provider_id: String(item.provider_id || '').trim(),
      provider_type: providerType,
      base_url: String(item.base_url || '').trim(),
      capabilities: normalizeProviderCapabilityOverrides(item.capabilities, providerType),
      quota: normalizeKeyQuota(item.quota),
      api_key: normalizeApiKeyField(item.api_key),
      api_key_env: normalizeOptional(item.api_key_env),
      key_rotation_strategy: normalizeRotationStrategy(item.key_rotation_strategy),
      auto_disable_on_error: item.auto_disable_on_error !== false,
      auto_recover_minutes: normalizeAutoRecoverMinutes(item.auto_recover_minutes),
      timeout_seconds: Number(item.timeout_seconds || 300),
      stream_idle_timeout_seconds: Number(item.stream_idle_timeout_seconds || 120),
      enabled: item.enabled !== false,
      headers: normalizeHeaders(item.headers || {}),
      anti_ban: normalizeAntiBanConfig(item.anti_ban),
      circuit_breaker: normalizeCircuitBreaker(item.circuit_breaker),
      description: String(item.description || '').trim()
    };
  });

  const models = (raw.models || []).map((item) => ({
    route_id: typeof item.route_id === 'string' && item.route_id.trim() ? item.route_id.trim() : nanoid(),
    client_model: String(item.client_model || '').trim(),
    provider_id: String(item.provider_id || '').trim(),
    upstream_model: String(item.upstream_model || '').trim(),
    priority: normalizeRoutePriority(item.priority),
    weight: normalizeRouteWeight(item.weight),
    enabled: item.enabled !== false,
    extra_body: isPlainObject(item.extra_body) ? item.extra_body : {},
    description: String(item.description || '').trim()
  }));

  return {
    revision: normalizeRevision(raw.revision),
    providers,
    models,
    default_client_model: normalizeOptional(raw.default_client_model),
    proxy_auth_token: normalizeOptional(raw.proxy_auth_token),
    key_max_errors: normalizeOptionalNumber(raw.key_max_errors),
    anti_ban: normalizeAntiBanConfig(raw.anti_ban)
  };
}

/**
 * 在 normalize 的基础上校验：
 *   - provider_id 唯一
 *   - model 引用的 provider 存在
 *   - default_client_model 必须存在于 models
 *   - 关键字段非空
 *
 * 校验失败抛 Error，文案直接面向用户（admin UI 会原样显示）。
 */
export function validateRuntimeConfig(raw: RuntimeConfig): RuntimeConfig {
  const config = normalizeRuntimeConfig(raw);

  const providerIds = config.providers.map((item) => item.provider_id);
  const repeatedProviderIds = findDuplicates(providerIds);
  if (repeatedProviderIds.length > 0) {
    throw new Error(`providers 中存在重复的 provider_id: ${repeatedProviderIds.join(', ')}`);
  }

  // 允许模型重名：多个路由使用相同 client_model 时，请求时随机选择
  // const modelIds = config.models.map((item) => item.client_model);
  // const repeatedModelIds = findDuplicates(modelIds);
  // if (repeatedModelIds.length > 0) {
  //   throw new Error(`models 中存在重复的 client_model: ${repeatedModelIds.join(', ')}`);
  // }

  const providerSet = new Set(providerIds);
  const invalidRefs = Array.from(new Set(config.models.filter((item) => !providerSet.has(item.provider_id)).map((item) => item.provider_id)));
  if (invalidRefs.length > 0) {
    throw new Error(`models 中引用了不存在的 provider_id: ${invalidRefs.join(', ')}`);
  }

  const routeIds = config.models.map((item) => item.route_id || '');
  const repeatedRouteIds = findDuplicates(routeIds);
  if (repeatedRouteIds.length > 0) {
    throw new Error(`models 中存在重复的 route_id: ${repeatedRouteIds.join(', ')}`);
  }

  if (config.default_client_model) {
    const modelNames = config.models.map((item) => item.client_model);
    const modelSet = new Set(modelNames);
    if (!modelSet.has(config.default_client_model)) {
      throw new Error('default_client_model 未在 models 中定义');
    }
  }

  for (const item of config.providers) {
    if (!item.provider_id) throw new Error('provider_id 不能为空');
    if (!item.base_url) throw new Error(`供应商 ${item.provider_id} 的 base_url 不能为空`);
  }
  const keyIds = config.providers.flatMap((provider) => Array.isArray(provider.api_key)
    ? provider.api_key.map((entry) => entry.id)
    : []);
  const repeatedKeyIds = findDuplicates(keyIds);
  if (repeatedKeyIds.length > 0) {
    throw new Error(`providers 中存在重复的 Key id: ${repeatedKeyIds.join(', ')}`);
  }
  for (const item of config.models) {
    if (!item.client_model) throw new Error('client_model 不能为空');
    if (!item.provider_id) throw new Error(`模型 ${item.client_model || '<未命名>'} 的 provider_id 不能为空`);
    if (!item.upstream_model) throw new Error(`模型 ${item.client_model || '<未命名>'} 的 upstream_model 不能为空`);
  }

  return config;
}

/**
 * 序列化前剥离 api_key 数组中的运行时字段；保留用户配置字段。
 *
 * 同时返回剥离出来的运行态记录（按 id 索引），迁移器会把它们写入 SQLite。
 * 这样配置快照只承载用户编辑字段，避免运行态变化污染配置历史。
 */
export function stripRuntimeFromConfig(config: RuntimeConfig): {
  config: RuntimeConfig;
  runtimeByProvider: Record<string, Record<string, ApiKeyRuntimeFields>>;
} {
  const runtimeByProvider: Record<string, Record<string, ApiKeyRuntimeFields>> = {};
  const providers = config.providers.map((p) => {
    if (!Array.isArray(p.api_key)) return p;
    const runtime: Record<string, ApiKeyRuntimeFields> = {};
    const cleaned: PersistedApiKey[] = p.api_key.map((entry) => {
      const persisted: PersistedApiKey = { id: entry.id, key: entry.key };
      if (entry.enabled === false) persisted.enabled = false;
      if (entry.note) persisted.note = entry.note;
      const rt: ApiKeyRuntimeFields = {};
      if (entry.error_count) rt.error_count = entry.error_count;
      if (entry.disabled_at != null) rt.disabled_at = entry.disabled_at;
      if (entry.last_error_at != null) rt.last_error_at = entry.last_error_at;
      if (entry.last_error_message != null) rt.last_error_message = entry.last_error_message;
      if (entry.auto_disabled_at != null) rt.auto_disabled_at = entry.auto_disabled_at;
      if (Object.keys(rt).length > 0) runtime[entry.id] = rt;
      return persisted;
    });
    if (Object.keys(runtime).length > 0) runtimeByProvider[p.provider_id] = runtime;
    return { ...p, api_key: cleaned as unknown as ApiKeyEntry[] };
  });
  return { config: { ...config, providers }, runtimeByProvider };
}

export function summarizeRuntimeConfig(config: RuntimeConfig): RuntimeConfigSummary {
  return {
    provider_count: config.providers.length,
    model_count: config.models.length,
    enabled_provider_count: config.providers.filter((item) => item.enabled !== false).length,
    enabled_model_count: config.models.filter((item) => item.enabled !== false).length,
    default_client_model: config.default_client_model || null
  };
}

// ---------------------------------------------------------------------------
// 以下为内部归一化辅助。命名保持与历史一致，方便排查日志。
// ---------------------------------------------------------------------------

function normalizeOptional(value: unknown): string | null {
  if (typeof value !== 'string') {
    return value == null ? null : String(value).trim() || null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeApiKeyField(value: unknown): string | ApiKeyEntry[] | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0)
      .map((k) => ({
        id: nanoid(),
        key: k,
        enabled: true,
        error_count: 0,
        disabled_at: null,
        last_error_at: null,
        last_error_message: null,
        auto_disabled_at: null
      }));
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is Partial<ApiKeyEntry> => item && typeof item === 'object' && typeof (item as Partial<ApiKeyEntry>).key === 'string')
      .map((item): ApiKeyEntry | null => {
        const key = String(item.key || '').trim();
        if (!key) return null;
        const note = item.note ? String(item.note).trim() : '';
        const rawId = typeof item.id === 'string' ? item.id.trim() : '';
        const base: ApiKeyEntry = {
          id: rawId || nanoid(),
          key,
          enabled: item.enabled !== false,
          error_count: Number(item.error_count) || 0,
          disabled_at: item.disabled_at ?? null,
          last_error_at: item.last_error_at ?? null,
          last_error_message: item.last_error_message ?? null,
          auto_disabled_at: item.auto_disabled_at ?? null
        };
        if (note) base.note = note;
        return base;
      })
      .filter((item): item is ApiKeyEntry => item !== null);
  }
  return null;
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[String(key).trim()] = String(value).trim();
  }
  return result;
}

function normalizeKeyQuota(value: unknown): KeyQuotaConfig | null | undefined {
  if (value === null) return null;
  if (!isPlainObject(value)) return undefined;
  const maxReq = normalizeOptionalNumber(value.max_requests);
  const maxTok = normalizeOptionalNumber(value.max_tokens);
  const maxCost = normalizeOptionalNumber(value.max_cost_usd);
  const inputCost = normalizeOptionalNumber(value.input_cost_per_million);
  const outputCost = normalizeOptionalNumber(value.output_cost_per_million);
  if (maxReq == null
    && maxTok == null
    && maxCost == null
    && inputCost == null
    && outputCost == null
    && value.soft_stop_threshold == null) return undefined;
  const result: KeyQuotaConfig = {
    max_requests: maxReq,
    max_tokens: maxTok
  };
  if (maxCost != null) result.max_cost_usd = maxCost;
  if (inputCost != null) result.input_cost_per_million = inputCost;
  if (outputCost != null) result.output_cost_per_million = outputCost;
  const threshold = Number(value.soft_stop_threshold);
  if (Number.isFinite(threshold) && threshold > 0 && threshold <= 1) {
    result.soft_stop_threshold = threshold;
  }
  return result;
}

function normalizeAntiBanConfig(value: unknown): AntiBanConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: AntiBanConfig = {};
  if (value.mode === 'conservative' || value.mode === 'throughput') {
    result.mode = value.mode;
  }
  const maxConcurrent = normalizeOptionalNumber(value.max_concurrent);
  if (maxConcurrent != null) result.max_concurrent = Math.trunc(maxConcurrent);
  const minInterval = normalizeNonNegativeNumber(value.min_interval_ms);
  if (minInterval != null) result.min_interval_ms = minInterval;
  const delayMin = normalizeNonNegativeNumber(value.rate_limit_delay_min_ms);
  if (delayMin != null) result.rate_limit_delay_min_ms = delayMin;
  const delayMax = normalizeNonNegativeNumber(value.rate_limit_delay_max_ms);
  if (delayMax != null) result.rate_limit_delay_max_ms = delayMax;
  if (value.key_selection === 'sticky' || value.key_selection === 'balanced') {
    result.key_selection = value.key_selection;
  }
  if (value.sticky_on_cooldown === 'wait' || value.sticky_on_cooldown === 'fallthrough') {
    result.sticky_on_cooldown = value.sticky_on_cooldown;
  }
  // 高级 anti-ban 配置需要白名单保留，否则 Admin 保存会意外清掉重试策略。
  const retry = normalizeRetryConfig(value.retry);
  if (retry) result.retry = retry;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeRetryConfig(value: unknown): RetryConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: RetryConfig = {};
  const attempts = normalizeOptionalNumber(value.max_attempts);
  if (attempts != null) result.max_attempts = Math.trunc(attempts);
  const totalMs = normalizeNonNegativeNumber(value.max_total_ms);
  if (totalMs != null) result.max_total_ms = Math.trunc(totalMs);
  if (typeof value.retry_on_rate_limit === 'boolean') result.retry_on_rate_limit = value.retry_on_rate_limit;
  if (typeof value.retry_on_transient === 'boolean') result.retry_on_transient = value.retry_on_transient;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeRotationStrategy(value: unknown): KeyRotationStrategy {
  if (value === KeyRotationStrategy.round_robin || value === KeyRotationStrategy.on_429) {
    return value;
  }
  return KeyRotationStrategy.round_robin;
}

function findDuplicates(values: string[]): string[] {
  const count = new Map<string, number>();
  for (const value of values) {
    count.set(value, (count.get(value) || 0) + 1);
  }
  return Array.from(count.entries()).filter(([, total]) => total > 1).map(([value]) => value);
}

function normalizeProviderType(value: unknown): 'openai_compatible' | 'anthropic' {
  if (value === 'anthropic') return 'anthropic';
  return 'openai_compatible';
}

// 自动恢复时长（分钟）：非有限值 / 负数 → 0（不自动恢复）。允许小数便于配秒级以下测试。
function normalizeAutoRecoverMinutes(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function normalizeOptionalNumber(value: unknown): number | null {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function normalizeProviderCapabilityOverrides(
  value: unknown,
  providerType: 'openai_compatible' | 'anthropic',
): ProviderCapabilityOverrides | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: ProviderCapabilityOverrides = {};
  if (typeof value.models === 'boolean') result.models = value.models;
  if (providerType === 'openai_compatible' && typeof value.responses === 'boolean') {
    result.responses = value.responses;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeCircuitBreaker(value: unknown): CircuitBreakerConfig | null {
  if (value === null) return null;
  const source = isPlainObject(value) ? value : {};
  const threshold = Number(source.failure_threshold);
  const recovery = Number(source.recovery_seconds);
  return {
    failure_threshold: Number.isFinite(threshold) && threshold >= 1
      ? Math.min(100, Math.trunc(threshold))
      : 3,
    recovery_seconds: Number.isFinite(recovery) && recovery >= 1
      ? Math.min(3600, Math.trunc(recovery))
      : 30,
  };
}

function normalizeRevision(value: unknown): number {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
}

function normalizeNonNegativeNumber(value: unknown): number | null {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}
