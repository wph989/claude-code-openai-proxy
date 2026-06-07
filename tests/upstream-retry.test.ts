import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApiKeyRotator } from '../src/services/api-key-rotator.js';
import { KeyRotationStrategy } from '../src/models.js';
import { UpstreamService } from '../src/services/upstream.js';
import { resolveAntiBanConfig, type ResolvedAntiBan } from '../src/services/anti-ban-config.js';

function keyEntry(k: string) {
  return { id: `id-${k}`, key: k, enabled: true, error_count: 0, disabled_at: null, last_error_at: null, last_error_message: null, auto_disabled_at: null };
}

function provider(keys: ReturnType<typeof keyEntry>[], antiBan: ResolvedAntiBan) {
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
    anti_ban: antiBan
  };
}

const route = () => ({ client_model: 'c', provider_id: 'p1', upstream_model: 'u', enabled: true, extra_body: {}, description: '' });

describe('UpstreamService retry loop', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('retries on 429 then succeeds', async () => {
    const svc = new UpstreamService();
    const ab = resolveAntiBanConfig({ mode: 'conservative', max_concurrent: 5, min_interval_ms: 0, rate_limit_delay_min_ms: 0, rate_limit_delay_max_ms: 0, retry: { max_attempts: 3, max_total_ms: 5000, retry_on_rate_limit: true, retry_on_transient: true } });
    const rotator = new ApiKeyRotator([keyEntry('a'), keyEntry('b')], KeyRotationStrategy.round_robin, true, ab);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const resp = await svc.postChatCompletions({
      provider: provider(rotator.getKeys(), ab), route: route(), rotator,
      payload: { model: 'u', messages: [] }, requestId: 'r', sessionId: 's'
    });
    expect(resp.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('retries fetch network errors as transient failures', async () => {
    const svc = new UpstreamService();
    const ab = resolveAntiBanConfig({ mode: 'conservative', max_concurrent: 5, min_interval_ms: 0, rate_limit_delay_min_ms: 0, rate_limit_delay_max_ms: 0, retry: { max_attempts: 3, max_total_ms: 5000, retry_on_rate_limit: true, retry_on_transient: true } });
    const rotator = new ApiKeyRotator([keyEntry('a')], KeyRotationStrategy.round_robin, true, ab);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const resp = await svc.postChatCompletions({
      provider: provider(rotator.getKeys(), ab), route: route(), rotator,
      payload: { model: 'u', messages: [] }, requestId: 'r', sessionId: 's'
    });

    expect(resp.status).toBe(200);
    expect(calls).toBe(2);
    expect(rotator.getKeyStatuses()[0].active_requests).toBe(0);
  });

  it('stops at max_attempts when always 429', async () => {
    const svc = new UpstreamService();
    const ab = resolveAntiBanConfig({ mode: 'conservative', max_concurrent: 5, min_interval_ms: 0, rate_limit_delay_min_ms: 0, rate_limit_delay_max_ms: 0, retry: { max_attempts: 2, max_total_ms: 5000, retry_on_rate_limit: true, retry_on_transient: true } });
    const rotator = new ApiKeyRotator([keyEntry('a')], KeyRotationStrategy.round_robin, true, ab);
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response('rate limit', { status: 429 }); }) as typeof fetch;

    const resp = await svc.postChatCompletions({
      provider: provider(rotator.getKeys(), ab), route: route(), rotator,
      payload: { model: 'u', messages: [] }, requestId: 'r', sessionId: 's'
    });
    expect(resp.status).toBe(429);
    expect(calls).toBe(2);
  });

  it('does not retry hard_limit', async () => {
    const svc = new UpstreamService();
    const ab = resolveAntiBanConfig({ mode: 'conservative', max_concurrent: 5, min_interval_ms: 0, rate_limit_delay_min_ms: 0, rate_limit_delay_max_ms: 0, retry: { max_attempts: 5, max_total_ms: 5000, retry_on_rate_limit: true, retry_on_transient: true } });
    const rotator = new ApiKeyRotator([keyEntry('a'), keyEntry('b')], KeyRotationStrategy.round_robin, true, ab);
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response('quota exceeded', { status: 429 }); }) as typeof fetch;

    const resp = await svc.postChatCompletions({
      provider: provider(rotator.getKeys(), ab), route: route(), rotator,
      payload: { model: 'u', messages: [] }, requestId: 'r', sessionId: 's'
    });
    expect(resp.status).toBe(429);
    expect(calls).toBe(1);
  });

  it('does not retry or penalize a key for request-size limits', async () => {
    const svc = new UpstreamService();
    const ab = resolveAntiBanConfig({ mode: 'conservative', max_concurrent: 5, min_interval_ms: 0, rate_limit_delay_min_ms: 100, rate_limit_delay_max_ms: 100, retry: { max_attempts: 3, max_total_ms: 5000, retry_on_rate_limit: true, retry_on_transient: true } });
    const rotator = new ApiKeyRotator([keyEntry('a'), keyEntry('b')], KeyRotationStrategy.round_robin, true, ab);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('context length exceeded', { status: 400, statusText: 'Bad Request' });
    }) as typeof fetch;

    const resp = await svc.postChatCompletions({
      provider: provider(rotator.getKeys(), ab), route: route(), rotator,
      payload: { model: 'u', messages: [] }, requestId: 'r', sessionId: 's'
    });

    expect(resp.status).toBe(400);
    expect(calls).toBe(1);
    const [state] = rotator.getKeyStatuses();
    expect(state.error_count).toBe(0);
    expect(state.last_error_category).toBeNull();
    expect(state.status).toBe('available');
    expect(state.active_requests).toBe(0);
  });

  it('stops on max_total_ms even with budget left', async () => {
    const svc = new UpstreamService();
    const ab = resolveAntiBanConfig({ mode: 'conservative', max_concurrent: 5, min_interval_ms: 0, rate_limit_delay_min_ms: 100, rate_limit_delay_max_ms: 100, retry: { max_attempts: 99, max_total_ms: 50, retry_on_rate_limit: true, retry_on_transient: true } });
    const rotator = new ApiKeyRotator([keyEntry('a')], KeyRotationStrategy.round_robin, true, ab);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('rate limit', { status: 429 });
    }) as typeof fetch;

    const start = Date.now();
    const resp = await svc.postChatCompletions({
      provider: provider(rotator.getKeys(), ab), route: route(), rotator,
      payload: { model: 'u', messages: [] }, requestId: 'r', sessionId: 's'
    });
    const elapsed = Date.now() - start;
    expect(resp.status).toBe(429);
    expect(calls).toBe(1);
    expect(elapsed).toBeLessThan(80);
  });

  it('returns 503 when no key can be acquired before the retry budget expires', async () => {
    const svc = new UpstreamService();
    const ab = resolveAntiBanConfig({ mode: 'conservative', max_concurrent: 5, min_interval_ms: 0, rate_limit_delay_min_ms: 100, rate_limit_delay_max_ms: 100, retry: { max_attempts: 2, max_total_ms: 20, retry_on_rate_limit: true, retry_on_transient: true } });
    const rotator = new ApiKeyRotator([keyEntry('a')], KeyRotationStrategy.round_robin, true, ab);
    rotator.markRateLimited('a', 'pre-existing cooldown');
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const start = Date.now();
    const resp = await svc.postChatCompletions({
      provider: provider(rotator.getKeys(), ab), route: route(), rotator,
      payload: { model: 'u', messages: [] }, requestId: 'r', sessionId: 's'
    });
    const elapsed = Date.now() - start;

    expect(resp.status).toBe(503);
    expect(calls).toBe(0);
    expect(elapsed).toBeLessThan(80);
  });

  it('streaming response is returned without retry attempts on body', async () => {
    const svc = new UpstreamService();
    const ab = resolveAntiBanConfig({ mode: 'conservative', max_concurrent: 5, min_interval_ms: 0, rate_limit_delay_min_ms: 0, rate_limit_delay_max_ms: 0, retry: { max_attempts: 3, max_total_ms: 5000, retry_on_rate_limit: true, retry_on_transient: true } });
    const rotator = new ApiKeyRotator([keyEntry('a')], KeyRotationStrategy.round_robin, true, ab);
    globalThis.fetch = (async () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;

    const resp = await svc.postChatCompletions({
      provider: provider(rotator.getKeys(), ab), route: route(), rotator,
      payload: { model: 'u', messages: [], stream: true }, requestId: 'r', sessionId: 's'
    });
    expect(resp.status).toBe(200);
  });
});
