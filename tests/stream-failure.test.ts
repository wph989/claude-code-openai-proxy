import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ApiKeyEntry } from '../src/models.js';
import { KeyRotationStrategy } from '../src/models.js';
import { ApiKeyRotator } from '../src/services/api-key-rotator.js';
import { resolveAntiBanConfig, type ResolvedAntiBan } from '../src/services/anti-ban-config.js';
import { pipeOpenAISse } from '../src/routes/chat-completions.js';
import { pipeUpstreamSse } from '../src/routes/messages.js';
import { bridgeOpenAIStreamToAnthropic } from '../src/services/stream-bridge.js';
import { UpstreamService, markUpstreamResponseStreamError, releaseUpstreamResponse } from '../src/services/upstream.js';

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

const antiBan = resolveAntiBanConfig({
  min_interval_ms: 0,
  retry: { max_attempts: 1, max_total_ms: 1000 }
});

const route = {
  client_model: 'client-model',
  provider_id: 'p1',
  upstream_model: 'upstream-model',
  enabled: true,
  extra_body: {},
  description: ''
};

function provider(keys: ApiKeyEntry[], ab: ResolvedAntiBan = antiBan) {
  return {
    provider_id: 'p1',
    provider_type: 'openai_compatible' as const,
    base_url: 'https://example.com/v1',
    api_keys: keys,
    key_rotation_strategy: KeyRotationStrategy.round_robin,
    auto_disable_on_error: true,
    timeout_seconds: 30,
    stream_idle_timeout_seconds: 1,
    enabled: true,
    headers: {},
    description: '',
    anti_ban: ab
  };
}

describe('stream failure handling', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('marks stream body failures and releases the leased key', async () => {
    const rotator = new ApiKeyRotator(
      [keyEntry('key-a'), keyEntry('key-b')],
      KeyRotationStrategy.round_robin,
      true,
      antiBan
    );
    globalThis.fetch = (async () => new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;

    const response = await new UpstreamService().postChatCompletions({
      provider: provider(rotator.getKeys()),
      route,
      rotator,
      payload: { model: 'upstream-model', messages: [], stream: true },
      requestId: 'req',
      sessionId: 'sess'
    });

    markUpstreamResponseStreamError(response, 'SSE idle timeout: 1000ms', 'network');
    releaseUpstreamResponse(response);

    const [first] = rotator.getKeyStatuses();
    expect(first.active_requests).toBe(0);
    expect(first.error_count).toBe(1);
    expect(first.last_error_category).toBe('network');
    expect(rotator.pick()).toBe('key-b');
  });

  it('closes Anthropic converted stream blocks when upstream body fails mid-stream', async () => {
    const encoder = new TextEncoder();
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
          return;
        }
        throw new Error('upstream stream broke');
      }
    });
    const response = new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await bridgeOpenAIStreamToAnthropic({
      upstreamResponse: response,
      output,
      clientModel: 'claude-test',
      messageId: 'msg_test',
      metrics: {
        requestId: 'req',
        sessionId: 'sess',
        providerId: 'p1',
        clientModel: 'claude-test',
        upstreamModel: 'upstream-model'
      },
      idleTimeoutMs: 1000
    });

    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain('event: content_block_stop');
    expect(text).toContain('event: message_delta');
    expect(text).toContain('event: message_stop');
  });

  it('marks converted stream failures from response metadata', async () => {
    const rotator = new ApiKeyRotator(
      [keyEntry('key-a'), keyEntry('key-b')],
      KeyRotationStrategy.round_robin,
      true,
      antiBan
    );
    const encoder = new TextEncoder();
    let pulled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
          return;
        }
        throw new Error('converted stream broke');
      }
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;

    const response = await new UpstreamService().postChatCompletions({
      provider: provider(rotator.getKeys()),
      route,
      rotator,
      payload: { model: 'upstream-model', messages: [], stream: true },
      requestId: 'req',
      sessionId: 'sess'
    });
    const output = new PassThrough();

    await bridgeOpenAIStreamToAnthropic({
      upstreamResponse: response,
      output,
      clientModel: 'claude-test',
      messageId: 'msg_test',
      metrics: {
        requestId: 'req',
        sessionId: 'sess',
        providerId: 'p1',
        clientModel: 'claude-test',
        upstreamModel: 'upstream-model'
      },
      idleTimeoutMs: 1000
    });

    const [first] = rotator.getKeyStatuses();
    expect(first.active_requests).toBe(0);
    expect(first.error_count).toBe(1);
    expect(first.last_error_category).toBe('network');
    expect(rotator.pick()).toBe('key-b');
  });

  it('finishes OpenAI passthrough SSE with DONE when upstream body fails', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('upstream stream broke');
      }
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await pipeOpenAISse({
      upstreamResponse: response,
      output,
      requestId: 'req',
      sessionId: 'sess',
      providerId: 'p1',
      clientModel: 'client-model',
      upstreamModel: 'upstream-model',
      idleTimeoutMs: 1000
    });

    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain('"type":"api_error"');
    expect(text).toContain('data: [DONE]');
  });

  it('marks Anthropic native passthrough stream failures and closes the Anthropic event sequence', async () => {
    const rotator = new ApiKeyRotator(
      [keyEntry('key-a'), keyEntry('key-b')],
      KeyRotationStrategy.round_robin,
      true,
      antiBan
    );
    const encoder = new TextEncoder();
    let pulled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(encoder.encode(
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_partial","type":"message","role":"assistant","content":[]}}\n\n' +
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n'
          ));
          return;
        }
        throw new Error('anthropic stream broke');
      }
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;

    const response = await new UpstreamService().postMessages({
      provider: { ...provider(rotator.getKeys()), provider_type: 'anthropic' as const },
      route,
      rotator,
      payload: { model: 'upstream-model', messages: [], stream: true },
      requestId: 'req',
      sessionId: 'sess'
    });
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    await pipeUpstreamSse({
      upstreamResponse: response,
      output,
      requestId: 'req',
      sessionId: 'sess',
      providerId: 'p1',
      clientModel: 'client-model',
      upstreamModel: 'upstream-model',
      idleTimeoutMs: 1000
    });

    const text = Buffer.concat(chunks).toString('utf8');
    const [first] = rotator.getKeyStatuses();
    expect(text).toContain('event: content_block_stop');
    expect(text).toContain('event: message_delta');
    expect(text).toContain('event: message_stop');
    expect(text).not.toContain('流式修复失败');
    expect(first.active_requests).toBe(0);
    expect(first.error_count).toBe(1);
    expect(first.last_error_category).toBe('network');
    expect(rotator.pick()).toBe('key-b');
  });

  it('releases OpenAI passthrough lease immediately when the client disconnects', async () => {
    const rotator = new ApiKeyRotator(
      [keyEntry('key-a')],
      KeyRotationStrategy.round_robin,
      true,
      antiBan
    );
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start() {
        // 保持 reader.read() pending，复现客户端断开时必须主动取消 reader 的场景。
      }
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;

    const response = await new UpstreamService().postChatCompletions({
      provider: provider(rotator.getKeys()),
      route,
      rotator,
      payload: { model: 'upstream-model', messages: [], stream: true },
      requestId: 'req',
      sessionId: 'sess'
    });
    expect(rotator.getKeyStatuses()[0].active_requests).toBe(1);

    const output = new PassThrough();
    output.resume();
    const abort = new AbortController();
    let clientClosed = false;
    const startedAt = Date.now();
    const pipeParams = {
      upstreamResponse: response,
      output,
      requestId: 'req',
      sessionId: 'sess',
      providerId: 'p1',
      clientModel: 'client-model',
      upstreamModel: 'upstream-model',
      idleTimeoutMs: 1000,
      isClientClosed: () => clientClosed,
      clientAbortSignal: abort.signal
    };
    const done = pipeOpenAISse(pipeParams);

    setTimeout(() => {
      clientClosed = true;
      abort.abort();
    }, 10);

    await done;
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(200);
    const [first] = rotator.getKeyStatuses();
    expect(first.active_requests).toBe(0);
    expect(first.error_count).toBe(0);
  });

  it('releases converted Anthropic stream lease immediately when the client disconnects', async () => {
    const rotator = new ApiKeyRotator(
      [keyEntry('key-a')],
      KeyRotationStrategy.round_robin,
      true,
      antiBan
    );
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start() {
        // 保持 reader.read() pending，验证 bridge 内部能通过 abort 及时释放 lease。
      }
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;

    const response = await new UpstreamService().postChatCompletions({
      provider: provider(rotator.getKeys()),
      route,
      rotator,
      payload: { model: 'upstream-model', messages: [], stream: true },
      requestId: 'req',
      sessionId: 'sess'
    });
    expect(rotator.getKeyStatuses()[0].active_requests).toBe(1);

    const output = new PassThrough();
    output.resume();
    const abort = new AbortController();
    let clientClosed = false;
    const startedAt = Date.now();
    const bridgeParams = {
      upstreamResponse: response,
      output,
      clientModel: 'claude-test',
      messageId: 'msg_test',
      metrics: {
        requestId: 'req',
        sessionId: 'sess',
        providerId: 'p1',
        clientModel: 'claude-test',
        upstreamModel: 'upstream-model'
      },
      idleTimeoutMs: 1000,
      isClientClosed: () => clientClosed,
      clientAbortSignal: abort.signal
    };
    const done = bridgeOpenAIStreamToAnthropic(bridgeParams);

    setTimeout(() => {
      clientClosed = true;
      abort.abort();
    }, 10);

    await done;
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(200);
    const [first] = rotator.getKeyStatuses();
    expect(first.active_requests).toBe(0);
    expect(first.error_count).toBe(0);
  });

  it('releases Anthropic native passthrough lease immediately when the client disconnects', async () => {
    const rotator = new ApiKeyRotator(
      [keyEntry('key-a')],
      KeyRotationStrategy.round_robin,
      true,
      antiBan
    );
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start() {
        // 保持 reader.read() pending，验证 native passthrough 能在客户端断开时退出。
      }
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;

    const response = await new UpstreamService().postMessages({
      provider: { ...provider(rotator.getKeys()), provider_type: 'anthropic' as const },
      route,
      rotator,
      payload: { model: 'upstream-model', messages: [], stream: true },
      requestId: 'req',
      sessionId: 'sess'
    });
    expect(rotator.getKeyStatuses()[0].active_requests).toBe(1);

    const output = new PassThrough();
    output.resume();
    const abort = new AbortController();
    let clientClosed = false;
    const startedAt = Date.now();
    const pipeParams = {
      upstreamResponse: response,
      output,
      requestId: 'req',
      sessionId: 'sess',
      providerId: 'p1',
      clientModel: 'client-model',
      upstreamModel: 'upstream-model',
      idleTimeoutMs: 1000,
      isClientClosed: () => clientClosed,
      clientAbortSignal: abort.signal
    };
    const done = pipeUpstreamSse(pipeParams);

    setTimeout(() => {
      clientClosed = true;
      abort.abort();
    }, 10);

    await done;
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(200);
    const [first] = rotator.getKeyStatuses();
    expect(first.active_requests).toBe(0);
    expect(first.error_count).toBe(0);
  });
});
