import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiKeyEntry } from '../src/models.js';
import { KeyRotationStrategy } from '../src/models.js';
import { ApiKeyRotator } from '../src/services/api-key-rotator.js';
import { UpstreamService, isQuotaLimitError } from '../src/services/upstream.js';

function keyEntry(key: string): ApiKeyEntry {
  return {
    key,
    enabled: true,
    error_count: 0,
    disabled_at: null,
    last_error_at: null,
    last_error_message: null,
    auto_disabled_at: null
  };
}

test('round_robin strategy keeps using the first selected key while it remains enabled', () => {
  const rotator = new ApiKeyRotator(
    [keyEntry('key-a'), keyEntry('key-b'), keyEntry('key-c')],
    KeyRotationStrategy.round_robin
  );

  assert.equal(rotator.pick(), 'key-a');
  assert.equal(rotator.pick(), 'key-a');
  assert.equal(rotator.pick(), 'key-a');
});

test('round_robin strategy moves to the next enabled key when the sticky key is disabled', () => {
  const rotator = new ApiKeyRotator(
    [keyEntry('key-a'), keyEntry('key-b'), keyEntry('key-c')],
    KeyRotationStrategy.round_robin
  );

  assert.equal(rotator.pick(), 'key-a');
  rotator.disableKey('key-a', 'quota exhausted');

  assert.equal(rotator.pick(), 'key-b');
  assert.equal(rotator.pick(), 'key-b');
});

test('quota error disables the used key immediately and records the reason', () => {
  const rotator = new ApiKeyRotator(
    [keyEntry('key-a'), keyEntry('key-b')],
    KeyRotationStrategy.round_robin
  );

  rotator.markQuotaError('key-a', 'HTTP 429: quota limit exceeded');

  const [first] = rotator.getKeys();
  assert.equal(first.enabled, false);
  assert.equal(first.last_error_message, 'HTTP 429: quota limit exceeded');
  assert.match(first.note || '', /quota/i);
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
  const rotator = new ApiKeyRotator([keyEntry('key-a'), keyEntry('key-b')], KeyRotationStrategy.round_robin);
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('temporary upstream failure', { status: 500, statusText: 'Internal Server Error' });
  }) as typeof fetch;

  try {
    const response = await service.postChatCompletions({
      provider: {
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com/v1',
        api_keys: rotator.getKeys(),
        key_rotation_strategy: KeyRotationStrategy.round_robin,
        auto_disable_on_error: true,
        timeout_seconds: 30,
        stream_idle_timeout_seconds: 120,
        enabled: true,
        headers: {},
        description: ''
      },
      route: {
        client_model: 'client',
        provider_id: 'p1',
        upstream_model: 'upstream',
        enabled: true,
        extra_body: {},
        description: ''
      },
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
  const rotator = new ApiKeyRotator([keyEntry('key-a'), keyEntry('key-b')], KeyRotationStrategy.round_robin);
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
      provider: {
        provider_id: 'p1',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com/v1',
        api_keys: rotator.getKeys(),
        key_rotation_strategy: KeyRotationStrategy.round_robin,
        auto_disable_on_error: true,
        timeout_seconds: 30,
        stream_idle_timeout_seconds: 120,
        enabled: true,
        headers: {},
        description: ''
      },
      route: {
        client_model: 'client',
        provider_id: 'p1',
        upstream_model: 'upstream',
        enabled: true,
        extra_body: {},
        description: ''
      },
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
