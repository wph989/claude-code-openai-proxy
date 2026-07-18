/**
 * 历史入口：保持 `from './models'` / `from '../models'` 的 import 路径继续可用。
 *
 * 实际定义已拆分为：
 *   - 类型定义：`src/types/runtime-config.ts`
 *   - normalize / validate / strip / summarize：`src/services/config/normalizer.ts`
 *
 * 这里只做 re-export，不引入新的运行时行为。
 */

export {
  KeyRotationStrategy,
  type AnthropicTool,
  type AnthropicMessageInput,
  type AnthropicMessagesRequest,
  type CountTokensRequest,
  type AntiBanMode,
  type KeySelectionMode,
  type StickyOnCooldown,
  type RetryConfig,
  type KeyQuotaConfig,
  type KeyUsage,
  type KeyRuntimeRecord,
  type AntiBanConfig,
  type ApiKeyEntry,
  type PersistedApiKey,
  type ProviderCapability,
  type ProviderCapabilityOverrides,
  type ProviderCapabilities,
  type ProviderConfig,
  type ModelRouteConfig,
  type RuntimeConfig,
  type RuntimeConfigSummary,
  type ResolvedProvider,
  type ResolvedRoute,
  type ApiKeyRuntimeFields,
} from './types/runtime-config.js';

export {
  normalizeRuntimeConfig,
  validateRuntimeConfig,
  stripRuntimeFromConfig,
  summarizeRuntimeConfig,
} from './services/config/normalizer.js';
