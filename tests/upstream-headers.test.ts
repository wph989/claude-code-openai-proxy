import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApiKeyRotator } from '../src/services/api-key-rotator.js';
import { KeyRotationStrategy } from '../src/models.js';
import { buildForwardRequestHeaders, filterForwardResponseHeaders } from '../src/services/http-headers.js';
import { UpstreamService } from '../src/services/upstream.js';
import { resolveAntiBanConfig, type ResolvedAntiBan } from '../src/services/anti-ban-config.js';

function keyEntry(k: string) {
  return { id: `id-${k}`, key: k, enabled: true, error_count: 0, disabled_at: null, last_error_at: null, last_error_message: null, auto_disabled_at: null };
}

function provider(keys: ReturnType<typeof keyEntry>[], antiBan: ResolvedAntiBan, overrides: Record<string, unknown> = {}) {
  return {
    provider_id: 'p1',
    provider_type: 'openai_compatible' as const,
    base_url: 'https://example.com/v1',
    api_keys: keys,
    key_rotation_strategy: KeyRotationStrategy.round_robin,
    auto_disable_on_error: true,
    timeout_seconds: 30,
    stream_idle_timeout_seconds: 120,
    enabled: true,
    headers: {},
    description: '',
    anti_ban: antiBan,
    ...overrides,
  };
}

const route = () => ({ client_model: 'c', provider_id: 'p1', upstream_model: 'u', enabled: true, extra_body: {}, description: '' });

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function mockFetchCapture(captured: CapturedRequest[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const reqInit = init ?? (input as RequestInit);
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    const headers: Record<string, string> = {};
    if (reqInit.headers) {
      const h = new Headers(reqInit.headers as HeadersInit);
      h.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    }
    captured.push({
      url,
      method: reqInit.method ?? 'GET',
      headers,
      body: typeof reqInit.body === 'string' ? reqInit.body : '',
    });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function makeAntiBan(): ResolvedAntiBan {
  return resolveAntiBanConfig({
    mode: 'conservative', max_concurrent: 5, min_interval_ms: 0,
    rate_limit_delay_min_ms: 0, rate_limit_delay_max_ms: 0,
    retry: { max_attempts: 1, max_total_ms: 1000, retry_on_rate_limit: false, retry_on_transient: false }
  });
}

describe('UpstreamService header forwarding', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('replaces client authorization with rotator key when rotator is present', async () => {
    const svc = new UpstreamService();
    const ab = makeAntiBan();
    const rotator = new ApiKeyRotator([keyEntry('rotator-key-1')], KeyRotationStrategy.round_robin, true, ab);
    const captured: CapturedRequest[] = [];
    globalThis.fetch = mockFetchCapture(captured);

    await svc.postChatCompletions({
      provider: provider(rotator.getKeys(), ab),
      route: route(),
      rotator,
      payload: { model: 'u', messages: [] },
      requestId: 'req-1', sessionId: 'sess-1',
      incomingHeaders: {
        'authorization': 'Bearer from-client',  // 客户端的代理鉴权 key
        'x-custom-header': 'kept',
        'transfer-encoding': 'chunked',          // hop-by-hop: should be stripped
        'connection': 'keep-alive',               // hop-by-hop: should be stripped
        'proxy-authorization': 'should-be-dropped',
        'x-anthropic-feature': 'cached',
      },
    });

    expect(captured).toHaveLength(1);
    const h = captured[0].headers;
    expect(h['authorization']).toBe('Bearer rotator-key-1');  // 替换成 rotator key
    expect(h['x-custom-header']).toBe('kept');
    expect(h['x-anthropic-feature']).toBe('cached');
    expect(h['transfer-encoding']).toBeUndefined();
    expect(h['connection']).toBeUndefined();
    expect(h['proxy-authorization']).toBeUndefined();
  });

  it('falls back to rotator key when client did not send authorization', async () => {
    const svc = new UpstreamService();
    const ab = makeAntiBan();
    const rotator = new ApiKeyRotator([keyEntry('rotator-key-1')], KeyRotationStrategy.round_robin, true, ab);
    const captured: CapturedRequest[] = [];
    globalThis.fetch = mockFetchCapture(captured);

    await svc.postChatCompletions({
      provider: provider(rotator.getKeys(), ab),
      route: route(),
      rotator,
      payload: { model: 'u', messages: [] },
      requestId: 'req-1', sessionId: 'sess-1',
      incomingHeaders: { 'x-trace-id': 'abc' },
    });

    expect(captured[0].headers['authorization']).toBe('Bearer rotator-key-1');
  });

  it('writes the rotator key to x-api-key (not authorization) for anthropic providers', async () => {
    const svc = new UpstreamService();
    const ab = makeAntiBan();
    const rotator = new ApiKeyRotator([keyEntry('sk-ant-test')], KeyRotationStrategy.round_robin, true, ab);
    const captured: CapturedRequest[] = [];
    globalThis.fetch = mockFetchCapture(captured);

    await svc.postMessages({
      provider: provider(rotator.getKeys(), ab, { provider_type: 'anthropic' }),
      route: route(),
      rotator,
      payload: { model: 'u', messages: [] },
      requestId: 'req-1', sessionId: 'sess-1',
      incomingHeaders: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' },
    });

    const h = captured[0].headers;
    expect(h['x-api-key']).toBe('sk-ant-test');
    expect(h['authorization']).toBeUndefined();
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['anthropic-beta']).toBe('prompt-caching-2024-07-31');
  });

  it('adds /v1 for Anthropic Messages when base_url is the provider root', async () => {
    const svc = new UpstreamService();
    const ab = makeAntiBan();
    const captured: CapturedRequest[] = [];
    globalThis.fetch = mockFetchCapture(captured);

    await svc.postMessages({
      provider: provider([], ab, { provider_type: 'anthropic', base_url: 'https://example.com' }),
      route: route(),
      payload: { model: 'u', messages: [] },
      requestId: 'req-1',
      sessionId: 'sess-1',
    });

    expect(captured[0].url).toBe('https://example.com/v1/messages');
  });

  it('does not duplicate /v1 for Anthropic Messages when base_url already includes it', async () => {
    const svc = new UpstreamService();
    const ab = makeAntiBan();
    const captured: CapturedRequest[] = [];
    globalThis.fetch = mockFetchCapture(captured);

    await svc.postMessages({
      provider: provider([], ab, { provider_type: 'anthropic', base_url: 'https://example.com/v1/' }),
      route: route(),
      payload: { model: 'u', messages: [] },
      requestId: 'req-1',
      sessionId: 'sess-1',
    });

    expect(captured[0].url).toBe('https://example.com/v1/messages');
  });

  it('adds /v1 for Anthropic count_tokens when base_url is the provider root', async () => {
    const svc = new UpstreamService();
    const ab = makeAntiBan();
    const captured: CapturedRequest[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url),
        method: init?.method ?? 'GET',
        headers: {},
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response('{"input_tokens":3}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    await svc.countTokensAnthropic({
      provider: provider([], ab, { provider_type: 'anthropic', base_url: 'https://example.com' }),
      route: route(),
      anthropicPayload: { messages: [] },
      requestId: 'req-1',
      sessionId: 'sess-1',
    });

    expect(captured[0].url).toBe('https://example.com/v1/messages/count_tokens');
  });

  it('replaces client x-api-key with rotator key for anthropic providers', async () => {
    const svc = new UpstreamService();
    const ab = makeAntiBan();
    const rotator = new ApiKeyRotator([keyEntry('sk-ant-rotator')], KeyRotationStrategy.round_robin, true, ab);
    const captured: CapturedRequest[] = [];
    globalThis.fetch = mockFetchCapture(captured);

    await svc.postMessages({
      provider: provider(rotator.getKeys(), ab, { provider_type: 'anthropic' }),
      route: route(),
      rotator,
      payload: { model: 'u', messages: [] },
      requestId: 'req-1', sessionId: 'sess-1',
      incomingHeaders: { 'x-api-key': 'sk-ant-from-client' },  // 客户端的代理鉴权 key
    });

    expect(captured[0].headers['x-api-key']).toBe('sk-ant-rotator');  // 替换成 rotator key
  });

  it('omits auth headers when neither client nor rotator provides one', async () => {
    const svc = new UpstreamService();
    const ab = makeAntiBan();
    const captured: CapturedRequest[] = [];
    globalThis.fetch = mockFetchCapture(captured);

    await svc.postChatCompletions({
      provider: provider([], ab),
      route: route(),
      payload: { model: 'u', messages: [] },
      requestId: 'req-1', sessionId: 'sess-1',
      incomingHeaders: { 'x-anything': 'value' },
    });

    const h = captured[0].headers;
    expect(h['authorization']).toBeUndefined();
    expect(h['x-api-key']).toBeUndefined();
  });

  it('provider.headers 作为兜底，不覆盖客户端已有的同名头', async () => {
    const svc = new UpstreamService();
    const ab = makeAntiBan();
    const rotator = new ApiKeyRotator([keyEntry('k')], KeyRotationStrategy.round_robin, true, ab);
    const captured: CapturedRequest[] = [];
    globalThis.fetch = mockFetchCapture(captured);

    await svc.postChatCompletions({
      provider: { ...provider(rotator.getKeys(), ab), headers: { 'x-from-provider': 'provider-value', 'x-provider-only': 'provider-only' } },
      route: route(),
      rotator,
      payload: { model: 'u', messages: [] },
      requestId: 'req-1', sessionId: 'sess-1',
      incomingHeaders: { 'x-from-provider': 'client-value', 'x-client-only': 'client-only' },
    });

    const h = captured[0].headers;
    // 客户端的头优先
    expect(h['x-from-provider']).toBe('client-value');
    // 客户端独有的头保留
    expect(h['x-client-only']).toBe('client-only');
    // provider 独有的头也添加（作为兜底）
    expect(h['x-provider-only']).toBe('provider-only');
  });

  it('forces Accept-Encoding identity when the env flag is enabled', async () => {
    const ab = makeAntiBan();
    const headers = buildForwardRequestHeaders({
      provider: provider([], ab),
      requestId: 'req-1',
      sessionId: 'sess-1',
      incomingHeaders: { 'accept-encoding': 'gzip, br' },
      forceIdentityAcceptEncoding: true,
    });

    expect(headers.get('accept-encoding')).toBe('identity');
  });

  it('filters response headers without dropping provider metadata', () => {
    const upstreamResponse = new Response('ok', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': '999',
        'content-encoding': 'gzip',
        connection: 'close',
        'transfer-encoding': 'chunked',
        'anthropic-request-id': 'anth-req',
        'x-request-id': 'req-1',
        'x-ratelimit-remaining': '12',
      },
    });

    const headers = filterForwardResponseHeaders(upstreamResponse);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['anthropic-request-id']).toBe('anth-req');
    expect(headers['x-request-id']).toBe('req-1');
    expect(headers['x-ratelimit-remaining']).toBe('12');
    expect(headers['content-length']).toBeUndefined();
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers.connection).toBeUndefined();
    expect(headers['transfer-encoding']).toBeUndefined();
  });
});
