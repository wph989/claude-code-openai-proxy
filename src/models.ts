/**
 * 核心数据模型与运行时配置校验。
 */
import { nanoid } from './utils/nanoid.js';

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicMessageInput {
  role: 'user' | 'assistant';
  content: string | Record<string, unknown>[];
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens?: number;
  messages: AnthropicMessageInput[];
  system?: string | Record<string, unknown>[];
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  metadata?: Record<string, unknown>;
}

export interface CountTokensRequest {
  model?: string;
  messages: AnthropicMessageInput[];
  system?: string | Record<string, unknown>[];
}

export enum KeyRotationStrategy {
  round_robin = 'round_robin',
  on_429 = 'on_429',
}

export type AntiBanMode = 'conservative' | 'throughput';

export type KeySelectionMode = 'sticky' | 'balanced';
export type StickyOnCooldown = 'wait' | 'fallthrough';

export interface RetryConfig {
  max_attempts?: number;
  max_total_ms?: number;
  retry_on_rate_limit?: boolean;
  retry_on_transient?: boolean;
}

export interface SelectorConfig {
  min_weight?: number;
}

export interface HealthConfig {
  window_ms?: number;
  rate_limit_penalty_per_event?: number;
  rate_limit_penalty_floor?: number;
  transient_penalty_per_event?: number;
  transient_penalty_floor?: number;
  consecutive_penalty_per_event?: number;
  consecutive_penalty_floor?: number;
  fresh_success_boost?: number;
  fresh_success_window_ms?: number;
  score_floor?: number;
  score_ceiling?: number;
}

export interface QuotaPersistConfig {
  persist_every_n_requests?: number;
  persist_critical_threshold?: number;
  usage_file?: string;
}

export interface KeyQuotaConfig {
  max_requests: number | null;
  max_tokens: number | null;
  soft_stop_threshold?: number;
}

export interface KeyUsage {
  requests_used: number;
  tokens_used: number;
}

export interface AntiBanConfig {
  mode?: AntiBanMode;
  max_concurrent?: number;
  min_interval_ms?: number;
  rate_limit_delay_min_ms?: number;
  rate_limit_delay_max_ms?: number;
  key_selection?: KeySelectionMode;
  sticky_on_cooldown?: StickyOnCooldown;
  retry?: RetryConfig;
  selector?: SelectorConfig;
  health?: HealthConfig;
  quota?: QuotaPersistConfig;
}

export interface ApiKeyEntry {
  id: string;
  key: string;
  enabled: boolean;
  error_count: number;
  disabled_at: number | null;
  last_error_at: number | null;
  last_error_message: string | null;
  auto_disabled_at: number | null;
  note?: string;
  quota?: KeyQuotaConfig | null;
}

/**
 * runtime_models.json 中实际持久化的 Key 形状：只保留用户配置字段。
 * 运行态字段（error_count / disabled_at / last_error_* / auto_disabled_at / 自动禁用后的 enabled）
 * 由 KeyStateStore 写入 runtime_state.json，按 id 索引；
 * id 一旦生成不再变更，用户改 key 字面量也能保留历史。
 */
export interface PersistedApiKey {
  id: string;
  key: string;
  enabled?: boolean;
  note?: string;
  quota?: KeyQuotaConfig | null;
}

export interface ProviderConfig {
  provider_id: string;
  provider_type: 'openai_compatible' | 'anthropic';
  base_url: string;
  quota?: KeyQuotaConfig | null;
  api_key?: string | ApiKeyEntry[] | null;
  api_key_env?: string | null;
  key_rotation_strategy?: KeyRotationStrategy | null;
  auto_disable_on_error?: boolean;
  timeout_seconds?: number;
  stream_idle_timeout_seconds?: number;
  enabled?: boolean;
  headers?: Record<string, string>;
  anti_ban?: AntiBanConfig;
  description?: string;
}

export interface ModelRouteConfig {
  client_model: string;
  provider_id: string;
  upstream_model: string;
  enabled?: boolean;
  extra_body?: Record<string, unknown>;
  description?: string;
}

export interface RuntimeConfig {
  providers: ProviderConfig[];
  models: ModelRouteConfig[];
  default_client_model?: string | null;
  proxy_auth_token?: string | null;
  key_max_errors?: number | null;
  anti_ban?: AntiBanConfig;
}

export interface RuntimeConfigSummary {
  provider_count: number;
  model_count: number;
  enabled_provider_count: number;
  enabled_model_count: number;
  default_client_model?: string | null;
}

export interface ResolvedProvider {
  provider_id: string;
  provider_type: 'openai_compatible' | 'anthropic';
  base_url: string;
  quota?: KeyQuotaConfig | null;
  api_keys: ApiKeyEntry[];
  key_rotation_strategy: KeyRotationStrategy;
  auto_disable_on_error: boolean;
  timeout_seconds: number;
  stream_idle_timeout_seconds: number;
  enabled: boolean;
  headers: Record<string, string>;
  anti_ban: import('./services/anti-ban-config.js').ResolvedAntiBan;
  description: string;
}

export interface ResolvedRoute {
  client_model: string;
  provider_id: string;
  upstream_model: string;
  enabled: boolean;
  extra_body: Record<string, unknown>;
  description: string;
}

export function normalizeRuntimeConfig(raw: RuntimeConfig): RuntimeConfig {
  const providers = (raw.providers || []).map((item) => ({
    provider_id: String(item.provider_id || '').trim(),
    provider_type: normalizeProviderType(item.provider_type),
    base_url: String(item.base_url || '').trim(),
    quota: normalizeKeyQuota(item.quota),
    api_key: normalizeApiKeyField(item.api_key),
    api_key_env: normalizeOptional(item.api_key_env),
    key_rotation_strategy: normalizeRotationStrategy(item.key_rotation_strategy),
    auto_disable_on_error: item.auto_disable_on_error !== false,
    timeout_seconds: Number(item.timeout_seconds || 300),
    stream_idle_timeout_seconds: Number(item.stream_idle_timeout_seconds || 120),
    enabled: item.enabled !== false,
    headers: normalizeHeaders(item.headers || {}),
    anti_ban: normalizeAntiBanConfig(item.anti_ban),
    description: String(item.description || '').trim()
  }));

  const models = (raw.models || []).map((item) => ({
    client_model: String(item.client_model || '').trim(),
    provider_id: String(item.provider_id || '').trim(),
    upstream_model: String(item.upstream_model || '').trim(),
    enabled: item.enabled !== false,
    extra_body: isPlainObject(item.extra_body) ? item.extra_body : {},
    description: String(item.description || '').trim()
  }));

  return {
    providers,
    models,
    default_client_model: normalizeOptional(raw.default_client_model),
    proxy_auth_token: normalizeOptional(raw.proxy_auth_token),
    key_max_errors: normalizeOptionalNumber(raw.key_max_errors),
    anti_ban: normalizeAntiBanConfig(raw.anti_ban)
  };
}

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
  for (const item of config.models) {
    if (!item.client_model) throw new Error('client_model 不能为空');
    if (!item.provider_id) throw new Error(`模型 ${item.client_model || '<未命名>'} 的 provider_id 不能为空`);
    if (!item.upstream_model) throw new Error(`模型 ${item.client_model || '<未命名>'} 的 upstream_model 不能为空`);
  }

  return config;
}

/**
 * 序列化前剥离 api_key 数组中的运行时字段；保留用户配置字段。
 * 同时返回剥离出来的运行态记录（按 id 索引），调用方可写入 KeyStateStore。
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
      if (entry.quota !== undefined) persisted.quota = entry.quota;
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

export interface ApiKeyRuntimeFields {
  error_count?: number;
  disabled_at?: number | null;
  last_error_at?: number | null;
  last_error_message?: string | null;
  auto_disabled_at?: number | null;
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
        const quota = normalizeKeyQuota(item.quota);
        if (quota !== undefined) base.quota = quota;
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
  if (maxReq == null && maxTok == null && value.soft_stop_threshold == null) return undefined;
  const result: KeyQuotaConfig = {
    max_requests: maxReq,
    max_tokens: maxTok
  };
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
  // 高级 anti-ban 配置需要白名单保留，否则 Admin 保存会意外清掉手写 JSON 调参。
  const retry = normalizeRetryConfig(value.retry);
  if (retry) result.retry = retry;
  const selector = normalizeSelectorConfig(value.selector);
  if (selector) result.selector = selector;
  const health = normalizeHealthConfig(value.health);
  if (health) result.health = health;
  const quota = normalizeQuotaPersistConfig(value.quota);
  if (quota) result.quota = quota;
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

function normalizeSelectorConfig(value: unknown): SelectorConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const minWeight = normalizeRatio(value.min_weight);
  return minWeight == null ? undefined : { min_weight: minWeight };
}

function normalizeHealthConfig(value: unknown): HealthConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: HealthConfig = {};
  setHealthNumber(result, 'window_ms', value.window_ms, true);
  setHealthNumber(result, 'rate_limit_penalty_per_event', value.rate_limit_penalty_per_event);
  setHealthNumber(result, 'rate_limit_penalty_floor', value.rate_limit_penalty_floor);
  setHealthNumber(result, 'transient_penalty_per_event', value.transient_penalty_per_event);
  setHealthNumber(result, 'transient_penalty_floor', value.transient_penalty_floor);
  setHealthNumber(result, 'consecutive_penalty_per_event', value.consecutive_penalty_per_event);
  setHealthNumber(result, 'consecutive_penalty_floor', value.consecutive_penalty_floor);
  setHealthNumber(result, 'fresh_success_boost', value.fresh_success_boost);
  setHealthNumber(result, 'fresh_success_window_ms', value.fresh_success_window_ms, true);
  setHealthNumber(result, 'score_floor', value.score_floor);
  setHealthNumber(result, 'score_ceiling', value.score_ceiling);
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeQuotaPersistConfig(value: unknown): QuotaPersistConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: QuotaPersistConfig = {};
  const every = normalizeNonNegativeNumber(value.persist_every_n_requests);
  if (every != null) result.persist_every_n_requests = Math.trunc(every);
  const critical = normalizeRatio(value.persist_critical_threshold);
  if (critical != null) result.persist_critical_threshold = critical;
  const usageFile = typeof value.usage_file === 'string' ? value.usage_file.trim() : '';
  if (usageFile) result.usage_file = usageFile;
  return Object.keys(result).length > 0 ? result : undefined;
}

function setHealthNumber(target: HealthConfig, key: keyof HealthConfig, raw: unknown, integer = false): void {
  const num = normalizeNonNegativeNumber(raw);
  if (num != null) {
    (target as Record<string, number>)[key] = integer ? Math.trunc(num) : num;
  }
}

function normalizeRotationStrategy(value: unknown): KeyRotationStrategy {
  if (value === KeyRotationStrategy.round_robin || value === KeyRotationStrategy.on_429) {
    return value;
  }
  return KeyRotationStrategy.round_robin;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

function normalizeOptionalNumber(value: unknown): number | null {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function normalizeNonNegativeNumber(value: unknown): number | null {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function normalizeRatio(value: unknown): number | null {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 && num <= 1 ? num : null;
}
