/**
 * 运行时配置的数据类型集合。
 *
 * 这里只放纯类型，不放校验/标准化逻辑（那些在 services/config/normalizer.ts）。
 * 拆分的目的是让 routes / services 引用类型时不需要把 normalize 链路也加载进来，
 * 同时让类型成为前后端共享的稳定契约。
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

export type AntiBanMode = 'conservative' | 'throughput';

export type KeySelectionMode = 'sticky' | 'balanced';
export type StickyOnCooldown = 'wait' | 'fallthrough';

export interface RetryConfig {
  max_attempts?: number;
  max_total_ms?: number;
  retry_on_rate_limit?: boolean;
  retry_on_transient?: boolean;
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
 *
 * 运行态字段（error_count / disabled_at / last_error_* / auto_disabled_at /
 * 自动禁用后的 enabled）由 KeyStateStore 写入 runtime_state.json，按 id 索引；
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
  // 自动禁用后经过多少分钟自动恢复（重新启用并清零错误计数）。0 / 未设 = 不自动恢复。
  auto_recover_minutes?: number;
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

/**
 * resolveModel 返回的运行时上下文：包含已展开的 anti_ban / api_keys / headers，
 * 供 upstream / passthrough 等模块直接使用，避免重复计算。
 */
export interface ResolvedProvider {
  provider_id: string;
  provider_type: 'openai_compatible' | 'anthropic';
  base_url: string;
  quota?: KeyQuotaConfig | null;
  api_keys: ApiKeyEntry[];
  key_rotation_strategy: KeyRotationStrategy;
  auto_disable_on_error: boolean;
  auto_recover_minutes: number;
  timeout_seconds: number;
  stream_idle_timeout_seconds: number;
  enabled: boolean;
  headers: Record<string, string>;
  anti_ban: import('../services/anti-ban-config.js').ResolvedAntiBan;
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

/**
 * 从 runtime_models.json 剥离运行态时返回的 patch 集合。
 * 由调用方写入 KeyStateStore，避免每次状态变更都重写 config 文件。
 */
export interface ApiKeyRuntimeFields {
  error_count?: number;
  disabled_at?: number | null;
  last_error_at?: number | null;
  last_error_message?: string | null;
  auto_disabled_at?: number | null;
}
