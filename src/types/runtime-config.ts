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

export interface KeyQuotaConfig {
  max_requests: number | null;
  max_tokens: number | null;
  /** 美元预算与每百万 Token 单价；仅配置费用字段时启用方向 Token/费用统计。 */
  max_cost_usd?: number | null;
  input_cost_per_million?: number | null;
  output_cost_per_million?: number | null;
  soft_stop_threshold?: number;
}

export interface KeyUsage {
  requests_used: number;
  tokens_used: number;
  input_tokens_used?: number;
  output_tokens_used?: number;
  cost_usd?: number;
}

/** SQLite key_states 表中的运行态补丁；与用户配置分离，保证多 Worker 事务一致。 */
export interface KeyRuntimeRecord {
  enabled?: boolean;
  error_count?: number;
  disabled_at?: number | null;
  last_error_at?: number | null;
  last_error_message?: string | null;
  auto_disabled_at?: number | null;
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
 * 迁移/配置 JSON 中实际持久化的 Key 形状：只保留用户配置字段。
 * 运行态字段由 SQLite key_states 表按稳定 ID 管理，用户修改 Key 字面量也能保留历史状态。
 */
export interface PersistedApiKey {
  id: string;
  key: string;
  enabled?: boolean;
  note?: string;
  quota?: KeyQuotaConfig | null;
}

export type ProviderCapability =
  | 'messages'
  | 'count_tokens'
  | 'chat_completions'
  | 'responses'
  | 'models';

/**
 * Provider 类型决定协议固有能力；这里只允许声明无法从类型可靠推断的可选端点。
 * Responses 在 OpenAI-compatible 生态中并非普遍实现，因此必须显式启用。
 */
export interface ProviderCapabilityOverrides {
  responses?: boolean;
  models?: boolean;
}

/** 运行时展开后的完整能力矩阵，路由选择不得再根据 URL 或模型名猜测能力。 */
export type ProviderCapabilities = Record<ProviderCapability, boolean>;

export interface ProviderConfig {
  provider_id: string;
  provider_type: 'openai_compatible' | 'anthropic';
  base_url: string;
  capabilities?: ProviderCapabilityOverrides;
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
  /** Provider 级网络/5xx 熔断；显式 null 可关闭。 */
  circuit_breaker?: CircuitBreakerConfig | null;
  description?: string;
}

export interface CircuitBreakerConfig {
  /** 连续达到该次数的网络/5xx 错误后打开熔断。 */
  failure_threshold?: number;
  /** 熔断保持打开的秒数，之后放行一个半开探测。 */
  recovery_seconds?: number;
}

export interface ModelRouteConfig {
  /** 稳定资源 ID；旧配置缺失时由 normalize 自动补齐。 */
  route_id?: string;
  client_model: string;
  provider_id: string;
  upstream_model: string;
  /** 同名路由中数值越小越优先，默认 0。 */
  priority?: number;
  /** 同优先级路由的相对流量权重，默认 1。 */
  weight?: number;
  enabled?: boolean;
  extra_body?: Record<string, unknown>;
  description?: string;
}

export interface RuntimeConfig {
  /** 配置的单调递增版本，用于管理端乐观并发控制。 */
  revision?: number;
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
  /** 兼容直接构造 ResolvedProvider 的旧调用方；RuntimeConfigManager 会始终补齐。 */
  capabilities?: ProviderCapabilities;
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
  /** 兼容直接构造 ResolvedProvider 的旧调用方；RuntimeConfigManager 会始终补齐。 */
  circuit_breaker?: CircuitBreakerConfig | null;
  description: string;
}

export interface ResolvedRoute {
  route_id: string;
  client_model: string;
  provider_id: string;
  upstream_model: string;
  /** 兼容旧测试/调用方；正常由 RuntimeConfigManager 标准化为数字。 */
  priority?: number;
  weight?: number;
  enabled: boolean;
  extra_body: Record<string, unknown>;
  description: string;
}

/**
 * 从迁移源配置剥离运行态时返回的 patch 集合。
 * 由迁移器写入 SQLite key_states，避免运行态变化污染配置快照。
 */
export interface ApiKeyRuntimeFields {
  error_count?: number;
  disabled_at?: number | null;
  last_error_at?: number | null;
  last_error_message?: string | null;
  auto_disabled_at?: number | null;
}
