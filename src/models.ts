/**
 * 核心数据模型与运行时配置校验。
 */

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

export interface ApiKeyEntry {
  key: string;
  enabled: boolean;
  error_count: number;
  disabled_at: number | null;
  last_error_at: number | null;
  last_error_message: string | null;
  auto_disabled_at: number | null;
  note?: string;
}

export interface ProviderConfig {
  provider_id: string;
  provider_type: 'openai_compatible' | 'anthropic';
  base_url: string;
  api_key?: string | ApiKeyEntry[] | null;
  api_key_env?: string | null;
  key_rotation_strategy?: KeyRotationStrategy | null;
  auto_disable_on_error?: boolean;
  timeout_seconds?: number;
  stream_idle_timeout_seconds?: number;
  enabled?: boolean;
  headers?: Record<string, string>;
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
  api_keys: ApiKeyEntry[];
  key_rotation_strategy: KeyRotationStrategy;
  auto_disable_on_error: boolean;
  timeout_seconds: number;
  stream_idle_timeout_seconds: number;
  enabled: boolean;
  headers: Record<string, string>;
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
    api_key: normalizeApiKeyField(item.api_key),
    api_key_env: normalizeOptional(item.api_key_env),
    key_rotation_strategy: normalizeRotationStrategy(item.key_rotation_strategy),
    auto_disable_on_error: item.auto_disable_on_error !== false,
    timeout_seconds: Number(item.timeout_seconds || 300),
    stream_idle_timeout_seconds: Number(item.stream_idle_timeout_seconds || 120),
    enabled: item.enabled !== false,
    headers: normalizeHeaders(item.headers || {}),
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
    key_max_errors: normalizeOptionalNumber(raw.key_max_errors)
  };
}

export function validateRuntimeConfig(raw: RuntimeConfig): RuntimeConfig {
  const config = normalizeRuntimeConfig(raw);

  const providerIds = config.providers.map((item) => item.provider_id);
  const repeatedProviderIds = findDuplicates(providerIds);
  if (repeatedProviderIds.length > 0) {
    throw new Error(`providers 中存在重复的 provider_id: ${repeatedProviderIds.join(', ')}`);
  }

  const modelIds = config.models.map((item) => item.client_model);
  const repeatedModelIds = findDuplicates(modelIds);
  if (repeatedModelIds.length > 0) {
    throw new Error(`models 中存在重复的 client_model: ${repeatedModelIds.join(', ')}`);
  }

  const providerSet = new Set(providerIds);
  const invalidRefs = Array.from(new Set(config.models.filter((item) => !providerSet.has(item.provider_id)).map((item) => item.provider_id)));
  if (invalidRefs.length > 0) {
    throw new Error(`models 中引用了不存在的 provider_id: ${invalidRefs.join(', ')}`);
  }

  if (config.default_client_model) {
    const modelSet = new Set(modelIds);
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
        const base: ApiKeyEntry = {
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
