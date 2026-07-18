import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAntiBanConfig, type ResolvedAntiBan } from '../src/services/anti-ban-config.js';
import { ProviderHealthRegistry } from '../src/services/provider-health.js';
import {
  markUpstreamResponseStreamError,
  releaseUpstreamResponse,
  safeJson,
  UpstreamService,
} from '../src/services/upstream.js';
import { KeyRotationStrategy } from '../src/models.js';

describe('ProviderHealthRegistry', () => {
  it('达到阈值后打开熔断，并只放行一个半开探测', () => {
    const registry = new ProviderHealthRegistry();
    registry.configure('p1', { failure_threshold: 2, recovery_seconds: 10 });

    const first = registry.acquire('p1', 1_000)!;
    registry.recordFailure('p1', 'network', first, 1_000);
    expect(registry.snapshot('p1', 1_000)).toMatchObject({ state: 'closed', consecutiveFailures: 1 });

    const second = registry.acquire('p1', 1_001)!;
    registry.recordFailure('p1', 'server', second, 1_001);
    expect(registry.snapshot('p1', 5_000)).toEqual({
      state: 'open',
      consecutiveFailures: 2,
      openUntil: 11_001,
    });
    expect(registry.acquire('p1', 5_000)).toBeNull();

    const probe = registry.acquire('p1', 11_001)!;
    expect(probe.probe).toBe(true);
    expect(registry.acquire('p1', 11_001)).toBeNull();
    expect(registry.snapshot('p1', 11_001).state).toBe('half_open');

    registry.recordSuccess('p1', probe);
    expect(registry.snapshot('p1', 11_002)).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
      openUntil: null,
    });
  });

  it('半开探测失败后重新冷却，未执行的探测可显式归还', () => {
    const registry = new ProviderHealthRegistry();
    registry.configure('p1', { failure_threshold: 1, recovery_seconds: 1 });
    const initial = registry.acquire('p1', 0)!;
    registry.recordFailure('p1', 'network', initial, 0);

    const abandoned = registry.acquire('p1', 1_000)!;
    expect(abandoned.probe).toBe(true);
    registry.release('p1', abandoned);

    const probe = registry.acquire('p1', 1_000)!;
    registry.recordFailure('p1', 'server', probe, 1_000);
    expect(registry.snapshot('p1', 1_999).state).toBe('open');
    expect(registry.snapshot('p1', 2_000).state).toBe('half_open');
  });

  it('熔断打开后忽略同代并发请求的迟到成功', () => {
    const registry = new ProviderHealthRegistry();
    registry.configure('p1', { failure_threshold: 1, recovery_seconds: 30 });
    const failed = registry.acquire('p1', 100)!;
    const staleSuccess = registry.acquire('p1', 100)!;

    registry.recordFailure('p1', 'network', failed, 100);
    registry.recordSuccess('p1', staleSuccess);

    expect(registry.snapshot('p1', 101)).toEqual({
      state: 'open',
      consecutiveFailures: 1,
      openUntil: 30_100,
    });
  });

  it('显式 null 关闭熔断并清理旧状态', () => {
    const registry = new ProviderHealthRegistry();
    registry.configure('p1', { failure_threshold: 1, recovery_seconds: 30 });
    const lease = registry.acquire('p1', 0)!;
    registry.recordFailure('p1', 'network', lease, 0);

    registry.configure('p1', null);
    expect(registry.isAvailable('p1', 1)).toBe(true);
    expect(registry.snapshot('p1', 1)).toEqual({
      state: 'closed',
      consecutiveFailures: 0,
      openUntil: null,
    });
  });
});

describe('UpstreamService Provider 熔断集成', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('半开请求在响应消费完成前保持占用，release 后才关闭熔断', async () => {
    const registry = openCircuit();
    vi.setSystemTime(1_000);
    globalThis.fetch = vi.fn(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const response = await new UpstreamService(undefined, undefined, registry).postChatCompletions({
      provider: provider(defaultAntiBan()),
      route: route(),
      payload: { model: 'u', messages: [] },
      requestId: 'r',
      sessionId: 's',
    });

    expect(registry.snapshot('p1').state).toBe('half_open');
    expect(registry.acquire('p1')).toBeNull();
    releaseUpstreamResponse(response);
    expect(registry.snapshot('p1').state).toBe('closed');
  });

  it('半开请求收到 429 时证明链路可达并关闭熔断', async () => {
    const registry = openCircuit();
    vi.setSystemTime(1_000);
    globalThis.fetch = vi.fn(async () => new Response('rate limit', { status: 429 })) as typeof fetch;

    const response = await new UpstreamService(undefined, undefined, registry).postChatCompletions({
      provider: provider(defaultAntiBan({ max_attempts: 1 })),
      route: route(),
      payload: { model: 'u', messages: [] },
      requestId: 'r',
      sessionId: 's',
    });

    expect(response.status).toBe(429);
    expect(registry.snapshot('p1').state).toBe('closed');
  });

  it('半开请求收到 5xx 时重新打开熔断且不继续同 Provider 重试', async () => {
    const registry = openCircuit();
    vi.setSystemTime(1_000);
    const fetchMock = vi.fn(async () => new Response('temporary', { status: 500 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const response = await new UpstreamService(undefined, undefined, registry).postChatCompletions({
      provider: provider(defaultAntiBan({ max_attempts: 3 })),
      route: route(),
      payload: { model: 'u', messages: [] },
      requestId: 'r',
      sessionId: 's',
    });

    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(registry.snapshot('p1').state).toBe('open');
  });

  it('流式断流记录失败后，最终 release 不会误关熔断', async () => {
    const registry = openCircuit();
    vi.setSystemTime(1_000);
    globalThis.fetch = vi.fn(async () => new Response('data: first\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch;

    const response = await new UpstreamService(undefined, undefined, registry).postChatCompletions({
      provider: provider(defaultAntiBan()),
      route: route(),
      payload: { model: 'u', messages: [], stream: true },
      requestId: 'r',
      sessionId: 's',
    });

    markUpstreamResponseStreamError(response, 'stream reset', 'network');
    releaseUpstreamResponse(response);
    expect(registry.snapshot('p1').state).toBe('open');
    expect(registry.snapshot('p1').openUntil).toBe(2_000);
  });

  it('非流式 200 响应读取 body 失败时重新打开熔断并释放探测', async () => {
    const registry = openCircuit();
    vi.setSystemTime(1_000);
    globalThis.fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error('body reset'));
      },
    }), { status: 200 })) as typeof fetch;

    const response = await new UpstreamService(undefined, undefined, registry).postChatCompletions({
      provider: provider(defaultAntiBan()),
      route: route(),
      payload: { model: 'u', messages: [] },
      requestId: 'r',
      sessionId: 's',
    });

    await expect(safeJson(response)).rejects.toThrow('body reset');
    expect(registry.snapshot('p1')).toMatchObject({ state: 'open', openUntil: 2_000 });
    expect(registry.acquire('p1')).toBeNull();
  });
});

function openCircuit(): ProviderHealthRegistry {
  const registry = new ProviderHealthRegistry();
  registry.configure('p1', { failure_threshold: 1, recovery_seconds: 1 });
  const lease = registry.acquire('p1', 0)!;
  registry.recordFailure('p1', 'network', lease, 0);
  return registry;
}

function defaultAntiBan(retry: { max_attempts?: number } = {}): ResolvedAntiBan {
  return resolveAntiBanConfig({
    mode: 'conservative',
    max_concurrent: 2,
    min_interval_ms: 0,
    rate_limit_delay_min_ms: 0,
    rate_limit_delay_max_ms: 0,
    retry: {
      max_attempts: retry.max_attempts ?? 3,
      max_total_ms: 5_000,
      retry_on_rate_limit: true,
      retry_on_transient: true,
    },
  });
}

function provider(antiBan: ResolvedAntiBan) {
  return {
    provider_id: 'p1',
    provider_type: 'openai_compatible' as const,
    base_url: 'https://example.com/v1',
    api_keys: [],
    key_rotation_strategy: KeyRotationStrategy.round_robin,
    auto_disable_on_error: true,
    auto_recover_minutes: 0,
    timeout_seconds: 30,
    stream_idle_timeout_seconds: 120,
    enabled: true,
    headers: {},
    anti_ban: antiBan,
    circuit_breaker: { failure_threshold: 1, recovery_seconds: 1 },
    description: '',
  };
}

function route() {
  return {
    route_id: 'route-1',
    client_model: 'c',
    provider_id: 'p1',
    upstream_model: 'u',
    priority: 0,
    weight: 1,
    enabled: true,
    extra_body: {},
    description: '',
  };
}
