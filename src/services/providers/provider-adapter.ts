import type { ResolvedProvider } from '../../types/runtime-config.js';
import {
  buildChatCompletionsUrl,
  buildCountTokensUrl,
  buildMessagesUrl,
} from '../upstream/url-builder.js';

export type ProviderType = ResolvedProvider['provider_type'];

export interface ProviderAdapter {
  readonly providerType: ProviderType;
  buildChatCompletionsUrl(provider: ResolvedProvider): string;
  buildMessagesUrl(provider: ResolvedProvider): string;
  buildCountTokensUrl(provider: ResolvedProvider): string;
  applyAuthentication(headers: Headers, apiKey: string): void;
}

const openAICompatibleAdapter: ProviderAdapter = {
  providerType: 'openai_compatible',
  buildChatCompletionsUrl,
  buildMessagesUrl,
  buildCountTokensUrl,
  applyAuthentication(headers, apiKey) {
    headers.set('authorization', `Bearer ${apiKey}`);
    headers.delete('x-api-key');
  },
};

const anthropicAdapter: ProviderAdapter = {
  providerType: 'anthropic',
  buildChatCompletionsUrl,
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
