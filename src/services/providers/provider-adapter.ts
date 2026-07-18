import type {
  ProviderCapabilities,
  ProviderCapability,
  ProviderCapabilityOverrides,
  ResolvedProvider,
} from '../../types/runtime-config.js';
import {
  buildChatCompletionsUrl,
  buildCountTokensUrl,
  buildMessagesUrl,
  buildResponsesUrl,
} from '../upstream/url-builder.js';

export type ProviderType = ResolvedProvider['provider_type'];

export interface ProviderAdapter {
  readonly providerType: ProviderType;
  readonly defaultCapabilities: ProviderCapabilities;
  buildChatCompletionsUrl(provider: ResolvedProvider): string;
  buildResponsesUrl(provider: ResolvedProvider): string;
  buildMessagesUrl(provider: ResolvedProvider): string;
  buildCountTokensUrl(provider: ResolvedProvider): string;
  applyAuthentication(headers: Headers, apiKey: string): void;
}

const openAICompatibleAdapter: ProviderAdapter = {
  providerType: 'openai_compatible',
  defaultCapabilities: {
    messages: true,
    count_tokens: true,
    chat_completions: true,
    // 大量 OpenAI-compatible 上游尚未实现 Responses，默认关闭可避免把兼容类型误当完整 OpenAI API。
    responses: false,
    models: true,
  },
  buildChatCompletionsUrl,
  buildResponsesUrl,
  buildMessagesUrl,
  buildCountTokensUrl,
  applyAuthentication(headers, apiKey) {
    headers.set('authorization', `Bearer ${apiKey}`);
    headers.delete('x-api-key');
  },
};

const anthropicAdapter: ProviderAdapter = {
  providerType: 'anthropic',
  defaultCapabilities: {
    messages: true,
    count_tokens: true,
    chat_completions: false,
    responses: false,
    models: true,
  },
  buildChatCompletionsUrl,
  buildResponsesUrl,
  buildMessagesUrl,
  buildCountTokensUrl,
  applyAuthentication(headers, apiKey) {
    headers.set('x-api-key', apiKey);
    headers.delete('authorization');
  },
};

const PROVIDER_ADAPTERS: Record<ProviderType, ProviderAdapter> = {
  openai_compatible: openAICompatibleAdapter,
  anthropic: anthropicAdapter,
};

/**
 * 协议只能由显式 provider_type 选择；这里刻意不接受 URL、模型名或 Key 推断，
 * 避免相似地址在迁移供应商后悄悄走错认证与协议路径。
 */
export function getProviderAdapter(providerType: ProviderType): ProviderAdapter {
  return PROVIDER_ADAPTERS[providerType];
}

export function resolveProviderCapabilities(
  providerType: ProviderType,
  overrides?: ProviderCapabilityOverrides | ProviderCapabilities,
): ProviderCapabilities {
  const capabilities = { ...getProviderAdapter(providerType).defaultCapabilities };
  if (typeof overrides?.models === 'boolean') capabilities.models = overrides.models;
  if (providerType === 'openai_compatible' && typeof overrides?.responses === 'boolean') {
    capabilities.responses = overrides.responses;
  }
  return capabilities;
}

export function providerSupportsCapability(
  provider: {
    provider_type: ProviderType;
    capabilities?: ProviderCapabilityOverrides | ProviderCapabilities;
  },
  capability: ProviderCapability,
): boolean {
  return resolveProviderCapabilities(provider.provider_type, provider.capabilities)[capability];
}
