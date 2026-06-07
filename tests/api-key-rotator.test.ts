import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ApiKeyEntry, AntiBanConfig } from '../src/models.js';
import { KeyRotationStrategy, normalizeRuntimeConfig } from '../src/models.js';
import type { KeyUsage } from '../src/models.js';
import { ApiKeyRotator } from '../src/services/api-key-rotator.js';
import { UpstreamService, classifyUpstreamError, isQuotaLimitError, releaseUpstreamResponse } from '../src/services/upstream.js';
import { resolveAntiBanConfig } from '../src/services/anti-ban-config.js';

function keyEntry(key: string): ApiKeyEntry {
  return {
    id: `id-${key}`,
    key,
    enabled: true,
    error_count: 0,
    disabled_at: null,
    last_error_at: null,
    last_error_message: null,
    auto_disabled_at: null
  };
}

function ab(partial: AntiBanConfig = {}) {
  return resolveAntiBanConfig({
    mode: 'conservative',
    max_concurrent: 1,
    min_interval_ms: 0,
    rate_limit_delay_min_ms: 0,
    rate_limit_delay_max_ms: 0,
    retry: { max_attempts: 1, max_total_ms: 30000, retry_on_rate_limit: false, retry_on_transient: false },
    ...partial
  });
}

function provider(keys: ApiKeyEntry[]) {
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
    anti_ban: ab()
  };
}

function route() {
  return {
    client_model: 'client',
    provider_id: 'p1',
    upstream_model: 'upstream',
    enabled: true,
    extra_body: {},
    description: ''
  };
}

test('round_robin strategy keeps using the first selected key while it remains enabled', () => {
  const rotator = new ApiKeyRotator(
    [keyEntry('key-a'), keyEntry('key-b'), keyEntry('key-c')],
    KeyRotationStrategy.round_robin,
    true,
    ab()
  );

  assert.equal(rotator.pick(), 'key-a');
  assert.equal(rotator.pick(), 'key-a');
  assert.equal(rotator.pick(), 'key-a');
});

test('round_robin strategy moves to the next enabled key when the sticky key is disabled', () => {
  const rotator = new ApiKeyRotator(
    [keyEntry('key-a'), keyEntry('key-b'), keyEntry('key-c')],
    KeyRotationStrategy.round_robin,
    true,
    ab()
  );

  assert.equal(rotator.pick(), 'key-a');
  rotator.disableKey('key-a', 'quota exhausted');

  assert.equal(rotator.pick(), 'key-b');
  assert.equal(rotator.pick(), 'key-b');
});

test('quota error disables the used key immediately and records the reason', () => {
  const rotator = new ApiKeyRotator(
    [keyEntry('key-a'), keyEntry('key-b')],
    KeyRotationStrategy.round_robin,
    true,
    ab()
  );

  rotator.markQuotaError('key-a', 'HTTP 429: quota limit exceeded');

  const [first] = rotator.getKeys();
  assert.equal(first.enabled, false);
  assert.equal(first.last_error_message, 'HTTP 429: quota limit exceeded');
  assert.equal(first.note, undefined);
  assert.equal(rotator.pick(), 'key-b');
});

test('detects quota and limit errors from English and Chinese response bodies', () => {
  assert.equal(isQuotaLimitError('quota exceeded for this account'), true);
  assert.equal(isQuotaLimitError('请求已超过每日限额'), true);
  assert.equal(isQuotaLimitError('余额不足，请充值'), true);
  assert.equal(isQuotaLimitError('internal server error'), false);
});

test('upstream returns the first non-2xx response without exponential retry', async () => {
  const service = new UpstreamService();
  const rotator = new ApiKeyRotator([keyEntry('key-a'), keyEntry('key-b')], KeyRotationStrategy.round_robin, true, ab());
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('temporary upstream failure', { status: 500, statusText: 'Internal Server Error' });
  }) as typeof fetch;

  try {
    const response = await service.postChatCompletions({
      provider: provider(rotator.getKeys()),
      route: route(),
      rotator,
      payload: { model: 'upstream', messages: [] },
      requestId: 'req-1',
      sessionId: 'sess-1'
    });

    assert.equal(response.status, 500);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('upstream quota response disables the used key immediately', async () => {
  const service = new UpstreamService();
  const rotator = new ApiKeyRotator([keyEntry('key-a'), keyEntry('key-b')], KeyRotationStrategy.round_robin, true, ab());
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: { message: 'quota limit exceeded' } }), {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const response = await service.postChatCompletions({
      provider: provider(rotator.getKeys()),
      route: route(),
      rotator,
      payload: { model: 'upstream', messages: [] },
      requestId: 'req-1',
      sessionId: 'sess-1'
    });

    assert.equal(response.status, 429);
    const [first] = rotator.getKeys();
    assert.equal(first.enabled, false);
    assert.match(first.last_error_message || '', /quota limit exceeded/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('upstream insufficient_quota body auto-disables the key (hard limit wins over token-limit URL fragment)', async () => {
  const service = new UpstreamService();
  const rotator = new ApiKeyRotator([keyEntry('key-a'), keyEntry('key-b')], KeyRotationStrategy.round_robin, true, ab());
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      error: {
        code: 'insufficient_quota',
        message: 'You exceeded your current quota, please check your plan and billing details. see: https://help.aliyun.com/zh/model-studio/error-code#token-limit',
        type: 'insufficient_quota'
      }
    }), {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const response = await service.postChatCompletions({
      provider: provider(rotator.getKeys()),
      route: route(),
      rotator,
      payload: { model: 'upstream', messages: [] },
      requestId: 'req-1',
      sessionId: 'sess-1'
    });

    assert.equal(response.status, 429);
    const [first] = rotator.getKeyStatuses();
    // insufficient_quota 必须命中 hard_limit，把 key 自动禁用——URL 里 #token-limit 不能干扰判定。
    assert.equal(first.enabled, false);
    assert.equal(first.status, 'disabled');
    assert.equal(first.last_error_category, 'hard_limit');
    assert.ok(first.auto_disabled_at, 'auto_disabled_at should be set');
    assert.match(first.last_error_message || '', /insufficient_quota/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('conservative scheduler allows only one active request per key', async () => {
  const rotator = new ApiKeyRotator([keyEntry('key-a')], KeyRotationStrategy.round_robin, true, ab());

  const first = await rotator.acquire();
  let secondResolved = false;
  const secondPromise = rotator.acquire().then((lease) => {
    secondResolved = true;
    return lease;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondResolved, false);

  rotator.release(first);
  const second = await secondPromise;
  assert.equal(second.key, 'key-a');
  rotator.release(second);
});

test('scheduler waits for the configured minimum interval before reusing a key', async () => {
  const rotator = new ApiKeyRotator([keyEntry('key-a')], KeyRotationStrategy.round_robin, true, ab({ min_interval_ms: 25 }));

  const first = await rotator.acquire();
  rotator.release(first);

  const startedAt = Date.now();
  const second = await rotator.acquire();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 20, `expected at least 20ms delay, got ${elapsed}ms`);
  rotator.release(second);
});

test('plain 429 delays the next use of the key without disabling it', async () => {
  const rotator = new ApiKeyRotator([keyEntry('key-a')], KeyRotationStrategy.round_robin, true, ab({
    rate_limit_delay_min_ms: 25,
    rate_limit_delay_max_ms: 25
  }));

  const first = await rotator.acquire();
  rotator.release(first);
  rotator.markRateLimited('key-a', '429 Too Many Requests');

  const delayedState = rotator.getKeyStatuses()[0];
  assert.equal(delayedState.enabled, true);
  assert.equal(delayedState.status, 'delayed');
  assert.equal(delayedState.last_error_category, 'rate_limit');

  const startedAt = Date.now();
  const second = await rotator.acquire();
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 20, `expected at least 20ms delay, got ${elapsed}ms`);
  assert.equal(second.key, 'key-a');
  rotator.release(second);
});

test('acquire rejects when only temporarily delayed keys exceed the deadline', async () => {
  const rotator = new ApiKeyRotator([keyEntry('key-a')], KeyRotationStrategy.round_robin, true, ab({
    rate_limit_delay_min_ms: 50,
    rate_limit_delay_max_ms: 50
  }));

  rotator.markRateLimited('key-a', '429 Too Many Requests');

  await assert.rejects(
    () => rotator.acquire({ deadline: Date.now() + 10 }),
    /等待可用 API Key 超时/
  );
});

test('acquire waits for the earliest delayed key when the deadline allows it', async () => {
  const rotator = new ApiKeyRotator([keyEntry('key-a')], KeyRotationStrategy.round_robin, true, ab({
    rate_limit_delay_min_ms: 25,
    rate_limit_delay_max_ms: 25
  }));

  rotator.markRateLimited('key-a', '429 Too Many Requests');
  const startedAt = Date.now();
  const lease = await rotator.acquire({ deadline: Date.now() + 100 });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 20, `expected acquire to wait for cooldown, got ${elapsed}ms`);
  assert.equal(lease.key, 'key-a');
  rotator.release(lease);
});

test('repeated markRateLimited within cooldown window does not extend nextAvailableAt', () => {
  const rotator = new ApiKeyRotator([keyEntry('key-a')], KeyRotationStrategy.round_robin, true, ab({
    rate_limit_delay_min_ms: 5000,
    rate_limit_delay_max_ms: 5000
  }));

  rotator.markRateLimited('key-a', 'first 429');
  const firstNext = rotator.getKeyStatuses()[0].next_available_at!;
  assert.ok(firstNext, 'first rate-limit should set nextAvailableAt');

  rotator.markRateLimited('key-a', 'second 429 still in cooldown');
  rotator.markRateLimited('key-a', 'third 429 still in cooldown');
  const afterRepeats = rotator.getKeyStatuses()[0].next_available_at!;
  assert.equal(afterRepeats, firstNext, 'cooldown end time must not be pushed forward by repeated 429s');
});

test('sticky_on_cooldown wait keeps waiting for the sticky key instead of falling through', async () => {
  const rotator = new ApiKeyRotator([keyEntry('key-a'), keyEntry('key-b')], KeyRotationStrategy.round_robin, true, ab({
    key_selection: 'sticky',
    sticky_on_cooldown: 'wait',
    rate_limit_delay_min_ms: 25,
    rate_limit_delay_max_ms: 25
  }));

  assert.equal(rotator.pick(), 'key-a');
  rotator.markRateLimited('key-a', '429 Too Many Requests');

  const startedAt = Date.now();
  const lease = await rotator.acquire({ deadline: Date.now() + 100 });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed >= 20, `expected sticky wait to honor cooldown, got ${elapsed}ms`);
  assert.equal(lease.key, 'key-a');
  rotator.release(lease);
});

test('sticky selector re-evaluates after network errors instead of reusing the same key', () => {
  const rotator = new ApiKeyRotator([keyEntry('key-a'), keyEntry('key-b')], KeyRotationStrategy.round_robin, true, ab({
    key_selection: 'sticky'
  }));

  assert.equal(rotator.pick(), 'key-a');
  rotator.markError('key-a', 'socket hang up', 'network');

  assert.equal(rotator.pick(), 'key-b');
});

test('error classifier separates hard quota errors from temporary rate limits', () => {
  assert.equal(classifyUpstreamError(429, 'Too Many Requests', 'rate limit reached').category, 'rate_limit');
  assert.equal(classifyUpstreamError(429, 'Too Many Requests', 'insufficient quota').category, 'hard_limit');
  // quota 类必须优先于 token-limit：实际 NVIDIA 等上游 429 错误体里两者都可能出现。
  assert.equal(classifyUpstreamError(429, 'Too Many Requests', 'insufficient_quota token-limit').category, 'hard_limit');
  assert.equal(classifyUpstreamError(429, 'Too Many Requests', '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details"}}').category, 'hard_limit');
  assert.equal(classifyUpstreamError(429, 'Too Many Requests', 'context length exceeded').category, 'request_limit');
  assert.equal(classifyUpstreamError(400, 'Bad Request', 'input tokens too long').category, 'request_limit');
  assert.equal(classifyUpstreamError(401, 'Unauthorized', 'invalid api key').category, 'hard_limit');
  assert.equal(classifyUpstreamError(500, 'Internal Server Error', 'server exploded').category, 'transient');
});

test('runtime config normalizes global anti-ban settings for frontend configuration', () => {
  const config = normalizeRuntimeConfig({
    providers: [],
    models: [],
    anti_ban: {
      mode: 'throughput',
      max_concurrent: 3,
      min_interval_ms: 100,
      rate_limit_delay_min_ms: 1000,
      rate_limit_delay_max_ms: 3000
    }
  });

  assert.deepEqual(config.anti_ban, {
    mode: 'throughput',
    max_concurrent: 3,
    min_interval_ms: 100,
    rate_limit_delay_min_ms: 1000,
    rate_limit_delay_max_ms: 3000
  });
});

test('upstream fetch rejection releases the active request and records the network error', async () => {
  const service = new UpstreamService();
  const rotator = new ApiKeyRotator([keyEntry('key-a')], KeyRotationStrategy.round_robin, true, ab());
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    throw new Error('socket hang up');
  }) as typeof fetch;

  try {
    await assert.rejects(() => service.postChatCompletions({
      provider: provider(rotator.getKeys()),
      route: route(),
      rotator,
      payload: { model: 'upstream', messages: [] },
      requestId: 'req-1',
      sessionId: 'sess-1'
    }), /socket hang up/);

    const [state] = rotator.getKeyStatuses();
    assert.equal(state.active_requests, 0);
    assert.equal(state.error_count, 1);
    assert.equal(state.last_error_category, 'network');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streaming upstream response keeps the lease until the stream is released', async () => {
  const service = new UpstreamService();
  const rotator = new ApiKeyRotator([keyEntry('key-a')], KeyRotationStrategy.round_robin, true, ab());
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  }) as typeof fetch;

  try {
    const response = await service.postChatCompletions({
      provider: provider(rotator.getKeys()),
      route: route(),
      rotator,
      payload: { model: 'upstream', messages: [], stream: true },
      requestId: 'req-1',
      sessionId: 'sess-1'
    });

    assert.equal(rotator.getKeyStatuses()[0].active_requests, 1);
    releaseUpstreamResponse(response);
    assert.equal(rotator.getKeyStatuses()[0].active_requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('anthropic count_tokens classifies plain 429 as rate limit without disabling the key', async () => {
  const service = new UpstreamService();
  const rotator = new ApiKeyRotator([keyEntry('key-a')], KeyRotationStrategy.round_robin, true, ab());
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: { message: 'rate limit reached' } }), {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    await assert.rejects(() => service.countTokensAnthropic({
      provider: {
        ...provider(rotator.getKeys()),
        provider_type: 'anthropic'
      },
      route: route(),
      rotator,
      anthropicPayload: { messages: [] },
      requestId: 'req-1',
      sessionId: 'sess-1'
    }), /token/);

    const [state] = rotator.getKeyStatuses();
    assert.equal(state.enabled, true);
    assert.equal(state.last_error_category, 'rate_limit');
    assert.equal(state.active_requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('balanced selection mode picks across all enabled keys', async () => {
  const rotator = new ApiKeyRotator(
    [keyEntry('a'), keyEntry('b'), keyEntry('c')],
    KeyRotationStrategy.round_robin,
    true,
    ab({ key_selection: 'balanced' })
  );
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const k = rotator.pick();
    if (k) seen.add(k);
  }
  assert.ok(seen.size >= 2, 'balanced should reach >=2 keys, got ' + seen.size);
});

test('recordUsage notifies usageListener; soft-stop blocks key without disabling it', () => {
  const entry: ApiKeyEntry = {
    ...keyEntry('quota-key'),
    quota: { max_requests: 10, max_tokens: null, soft_stop_threshold: 0.9 }
  };
  const rotator = new ApiKeyRotator([entry, keyEntry('spare')], KeyRotationStrategy.round_robin, true, ab());
  const updates: Array<{ key: string; ratio: number }> = [];
  rotator.setUsageListener((key, _usage: KeyUsage, ratio) => updates.push({ key, ratio }));

  for (let i = 0; i < 9; i++) rotator.recordUsage('quota-key', 1, 0);

  assert.equal(updates.length, 9);
  assert.ok(updates[updates.length - 1].ratio >= 0.9);
  const [first] = rotator.getKeys();
  assert.equal(first.enabled, true);
  const status = rotator.getKeyStatuses()[0];
  assert.equal(status.quota_blocked, true);
  assert.match(status.quota_reason || '', /配额/);
  assert.equal(rotator.pick(), 'spare');
});

test('hydrateUsage restores prior usage and is reflected in getQuotaSnapshot', () => {
  const entry: ApiKeyEntry = {
    ...keyEntry('hk'),
    quota: { max_requests: 100, max_tokens: null, soft_stop_threshold: 0.95 }
  };
  const rotator = new ApiKeyRotator([entry], KeyRotationStrategy.round_robin, true, ab());
  rotator.hydrateUsage('hk', { requests_used: 50, tokens_used: 0 });
  const snap = rotator.getQuotaSnapshot('hk');
  assert.equal(snap.usage.requests_used, 50);
  assert.equal(snap.blocked, false);
});

test('hydrateUsage past soft_stop_threshold blocks the key so acquire fails fast', async () => {
  const entry: ApiKeyEntry = {
    ...keyEntry('hk'),
    quota: { max_requests: 100, max_tokens: null, soft_stop_threshold: 0.9 }
  };
  const rotator = new ApiKeyRotator([entry], KeyRotationStrategy.round_robin, true, ab());

  rotator.hydrateUsage('hk', { requests_used: 95, tokens_used: 0 });

  const status = rotator.getKeyStatuses()[0];
  assert.equal(status.enabled, true);
  assert.equal(status.quota_blocked, true);
  assert.equal(rotator.pick(), undefined);
});

test('setKeyQuota updates the live rotator without resetting health state', () => {
  const entry: ApiKeyEntry = {
    ...keyEntry('hk'),
    quota: { max_requests: 100, max_tokens: null, soft_stop_threshold: 0.9 }
  };
  const rotator = new ApiKeyRotator([entry], KeyRotationStrategy.round_robin, true, ab());
  rotator.markRateLimited('hk', '429 rate limit');
  const scoreBefore = rotator.getHealthScore('hk');
  assert.ok(scoreBefore < 1.0);

  rotator.setKeyQuota('hk', { max_requests: 500, max_tokens: null, soft_stop_threshold: 0.95 });

  assert.equal(rotator.getQuotaSnapshot('hk').quota?.max_requests, 500);
  assert.equal(rotator.getHealthScore('hk'), scoreBefore);
});
