import { describe, expect, it } from 'vitest';
import type { ResolvedProvider } from '../src/types/runtime-config.js';
import {
  getProviderAdapter,
  providerSupportsCapability,
  resolveProviderCapabilities,
} from '../src/services/providers/provider-adapter.js';

describe('ProviderAdapter 显式注册', () => {
  it('OpenAI compatible 使用 Bearer 认证和 chat/completions URL', () => {
    const provider = makeProvider('openai_compatible', 'https://example.com/v1');
    const adapter = getProviderAdapter(provider.provider_type);
    const headers = new Headers({ 'x-api-key': 'old' });
    adapter.applyAuthentication(headers, 'secret');

    expect(adapter.buildChatCompletionsUrl(provider)).toBe('https://example.com/v1/chat/completions');
    expect(adapter.buildResponsesUrl(provider)).toBe('https://example.com/v1/responses');
    expect(headers.get('authorization')).toBe('Bearer secret');
    expect(headers.has('x-api-key')).toBe(false);
  });

  it('Anthropic 使用 x-api-key 并规范化 Messages URL', () => {
    const provider = makeProvider('anthropic', 'https://example.com');
    const adapter = getProviderAdapter(provider.provider_type);
    const headers = new Headers({ authorization: 'Bearer old' });
    adapter.applyAuthentication(headers, 'secret');

    expect(adapter.buildMessagesUrl(provider)).toBe('https://example.com/v1/messages');
    expect(adapter.buildCountTokensUrl(provider)).toBe('https://example.com/v1/messages/count_tokens');
    expect(headers.get('x-api-key')).toBe('secret');
    expect(headers.has('authorization')).toBe(false);
  });

  it('Responses 默认关闭且只能由 OpenAI compatible 显式启用', () => {
    expect(resolveProviderCapabilities('openai_compatible')).toMatchObject({
      messages: true,
      count_tokens: true,
      chat_completions: true,
      responses: false,
      models: true,
    });
    expect(providerSupportsCapability({
      provider_type: 'openai_compatible',
      capabilities: { responses: true, models: false },
    }, 'responses')).toBe(true);
    expect(providerSupportsCapability({
      provider_type: 'anthropic',
      capabilities: { responses: true, models: true },
    }, 'responses')).toBe(false);
  });
});

function makeProvider(providerType: ResolvedProvider['provider_type'], baseUrl: string): ResolvedProvider {
  // 本测试只验证适配器使用的协议类型与 URL，其他运行时字段不参与行为。
  return {
    provider_id: 'p1',
    provider_type: providerType,
    base_url: baseUrl,
    api_keys: [],
    enabled: true,
    headers: {},
  } as ResolvedProvider;
}
