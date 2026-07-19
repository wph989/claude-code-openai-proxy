import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMigratedApp } from './test-app.js';

let tmp: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'ccop-passthrough-'));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(body: unknown): string {
  const cfgPath = path.join(tmp, 'runtime_models.json');
  writeFileSync(cfgPath, JSON.stringify(body), 'utf-8');
  return cfgPath;
}

function anthropicConfig(extraBody: Record<string, unknown> = {}) {
  return {
    providers: [{
      provider_id: 'anthropic-upstream',
      provider_type: 'anthropic',
      base_url: 'https://example.com/v1',
      api_key: [{ id: 'ANTHKEY0001', key: 'sk-ant-test' }],
      timeout_seconds: 30,
      stream_idle_timeout_seconds: 1,
      enabled: true,
      headers: {},
      anti_ban: { min_interval_ms: 0, retry: { max_attempts: 1, max_total_ms: 1000 } },
    }],
    models: [{
      client_model: 'claude-client',
      provider_id: 'anthropic-upstream',
      upstream_model: 'claude-upstream',
      extra_body: extraBody,
      enabled: true,
    }],
    default_client_model: 'claude-client',
  };
}

function openAIConfig() {
  return {
    providers: [{
      provider_id: 'openai-upstream',
      provider_type: 'openai_compatible',
      base_url: 'https://example.com/v1',
      api_key: [{ id: 'OPENAIKEY1', key: 'sk-openai-test' }],
      timeout_seconds: 30,
      stream_idle_timeout_seconds: 1,
      enabled: true,
      headers: {},
      anti_ban: { min_interval_ms: 0, retry: { max_attempts: 1, max_total_ms: 1000 } },
    }],
    models: [{
      client_model: 'gpt-client',
      provider_id: 'openai-upstream',
      upstream_model: 'gpt-upstream',
      enabled: true,
    }],
    default_client_model: 'gpt-client',
  };
}

describe('API 透传流水线', () => {
  it('Anthropic 原生透传发送 upstream_model 和 route.extra_body', async () => {
    const cfgPath = writeConfig(anthropicConfig({ extra_flag: true }));
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: typeof input === 'string' ? input : input.toString(),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({
        id: 'msg-upstream',
        type: 'message',
        role: 'assistant',
        model: 'claude-upstream',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 3 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-client',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe('https://example.com/v1/messages');
      expect(captured[0].body.model).toBe('claude-upstream');
      expect(captured[0].body.max_tokens).toBe(16);
      expect(captured[0].body.extra_flag).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('Anthropic 非流式透传会递归移除所有 stream_options', async () => {
    const cfgPath = writeConfig(anthropicConfig({ stream_options: { include_usage: true } }));
    const captured: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      captured.push(body);
      return new Response(JSON.stringify({
        id: 'msg-cleaned',
        type: 'message',
        role: 'assistant',
        model: 'claude-upstream',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-client',
          max_tokens: 16,
          stream: false,
          metadata: {
            nested: {
              stream_options: { include_usage: true },
            },
          },
          messages: [{
            role: 'user',
            content: [{
              type: 'text',
              text: 'hi',
              stream_options: { include_usage: true },
            }],
          }],
          stream_options: { include_usage: true },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.stringify(captured[0])).not.toContain('stream_options');
      expect(captured[0].stream).toBe(false);
      expect(captured[0].model).toBe('claude-upstream');
    } finally {
      await app.close();
    }
  });

  it('Anthropic 流式上游错误保留非 2xx 状态码', async () => {
    const cfgPath = writeConfig(anthropicConfig());

    globalThis.fetch = (async () => new Response('upstream exploded', {
      status: 500,
      statusText: 'Internal Server Error',
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-request-id': 'upstream-req' },
    })) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-client',
          max_tokens: 16,
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.body).toContain('upstream exploded');
      expect(response.headers['x-request-id']).toBe('upstream-req');
    } finally {
      await app.close();
    }
  });

  it('正常 Anthropic SSE 也会补齐 Claude Code 必需字段和收尾事件', async () => {
    const cfgPath = writeConfig(anthropicConfig());
    const encoder = new TextEncoder();

    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: message_start\n' +
          'data: {"type":"message_start","message":{"type":"message","role":"assistant","model":"claude-upstream","content":[]}}\n\n' +
          'event: content_block_start\n' +
          'data: {"type":"content_block_start","index":5,"content_block":{"type":"text","text":""}}\n\n' +
          'event: content_block_delta\n' +
          'data: {"type":"content_block_delta","index":5,"delta":{"type":"text_delta","text":"hi"}}\n\n'
        ));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    })) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-client',
          max_tokens: 16,
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('event: message_start');
      expect(response.body).toContain('"id":"msg_');
      expect(response.body).toContain('cache_creation_input_tokens');
      expect(response.body).toContain('cache_read_input_tokens');
      expect(response.body).toContain('server_tool_use');
      expect(response.body).toContain('"index":0');
      expect(response.body).toContain('event: content_block_stop');
      expect(response.body).toContain('event: message_delta');
      expect(response.body).toContain('event: message_stop');
    } finally {
      await app.close();
    }
  });

  it('OpenAI Chat 流式上游错误保留非 2xx 状态码', async () => {
    const cfgPath = writeConfig(openAIConfig());

    globalThis.fetch = (async () => new Response('bad gateway from upstream', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-ratelimit-remaining': '0' },
    })) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'gpt-client',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      expect(response.statusCode).toBe(502);
      expect(response.body).toContain('bad gateway from upstream');
      expect(response.headers['x-ratelimit-remaining']).toBe('0');
    } finally {
      await app.close();
    }
  });

  it('Anthropic JSON 缺 id/usage 时会补齐 Claude Code 必需字段', async () => {
    const cfgPath = writeConfig(anthropicConfig());

    globalThis.fetch = (async () => new Response(JSON.stringify({
      type: 'message',
      role: 'assistant',
      model: 'claude-upstream',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'json-req',
        'x-ratelimit-remaining': '42',
      },
    })) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-client',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      const body = JSON.parse(response.body);
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-request-id']).toBe('json-req');
      expect(response.headers['x-ratelimit-remaining']).toBe('42');
      expect(body.id).toMatch(/^msg_/);
      expect(body.usage.input_tokens).toBe(0);
      expect(body.usage.cache_creation_input_tokens).toBe(0);
      expect(body.usage.cache_read_input_tokens).toBe(0);
      expect(body.usage.output_tokens).toBe(1);
      expect(body.usage.server_tool_use).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('Anthropic 非流式 OpenAI JSON 会转换为 Anthropic message', async () => {
    const cfgPath = writeConfig(anthropicConfig());

    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'chatcmpl-json',
      object: 'chat.completion',
      model: 'gpt-upstream',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hello from openai json' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-client',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      const body = JSON.parse(response.body);
      expect(response.statusCode).toBe(200);
      expect(body.type).toBe('message');
      expect(body.id).toMatch(/^msg_/);
      expect(body.content[0]).toEqual({ type: 'text', text: 'hello from openai json' });
      expect(body.stop_reason).toBe('end_turn');
      expect(body.usage.input_tokens).toBe(5);
      expect(body.usage.output_tokens).toBe(6);
    } finally {
      await app.close();
    }
  });

  it('Anthropic 非流式推理 JSON 会保留 reasoning_content', async () => {
    const cfgPath = writeConfig(openAIConfig());

    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'chatcmpl-reasoning',
      choices: [{
        message: { role: 'assistant', reasoning_content: '先判断', content: '最终回答' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 6 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'gpt-client',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      const body = JSON.parse(response.body);
      expect(response.statusCode).toBe(200);
      expect(body.content).toEqual([
        { type: 'thinking', thinking: '先判断' },
        { type: 'text', text: '最终回答' },
      ]);
    } finally {
      await app.close();
    }
  });

  it('Anthropic 非流式收到空 OpenAI JSON 会返回 502，而不是伪造空成功', async () => {
    const cfgPath = writeConfig(openAIConfig());

    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'chatcmpl-empty',
      choices: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      app.runtimeConfigManager.resolveModel('gpt-client', 'messages').rotator?.markError(
        'sk-openai-test',
        '已有瞬时错误',
        'transient',
      );
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'gpt-client',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      const body = JSON.parse(response.body);
      expect(response.statusCode).toBe(502);
      expect(body.error.message).toContain('空响应');
      expect(app.runtimeConfigManager.getKeyStates('openai-upstream')[0].error_count).toBe(2);
      expect(app.runtimeConfigManager.getKeyStates('openai-upstream')[0].last_error_category).toBe('transient');
    } finally {
      await app.close();
    }
  });

  it('OpenAI Chat 非流式收到空 choices 会返回 502 并累计 Key 错误', async () => {
    const cfgPath = writeConfig(openAIConfig());

    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'chatcmpl-empty',
      choices: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'gpt-client',
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      expect(response.statusCode).toBe(502);
      expect(JSON.parse(response.body).error.message).toContain('空响应');
      expect(app.runtimeConfigManager.getKeyStates('openai-upstream')[0].error_count).toBe(1);
      expect(app.runtimeConfigManager.getKeyStates('openai-upstream')[0].last_error_category).toBe('transient');
    } finally {
      await app.close();
    }
  });

  it('Anthropic 原生非流式收到空 content 会返回 502 并累计 Key 错误', async () => {
    const cfgPath = writeConfig(anthropicConfig());

    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'msg-empty',
      type: 'message',
      role: 'assistant',
      model: 'claude-upstream',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-client',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      expect(response.statusCode).toBe(502);
      expect(JSON.parse(response.body).error.message).toContain('空响应');
      expect(app.runtimeConfigManager.getKeyStates('anthropic-upstream')[0].error_count).toBe(1);
      expect(app.runtimeConfigManager.getKeyStates('anthropic-upstream')[0].last_error_category).toBe('transient');
    } finally {
      await app.close();
    }
  });

  it('Anthropic /v1/messages 收到 2xx 非 JSON 会返回明确 502', async () => {
    const cfgPath = writeConfig(anthropicConfig());

    globalThis.fetch = (async () => new Response('<html>not api</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-client',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      const body = JSON.parse(response.body);
      expect(response.statusCode).toBe(502);
      expect(body.error.type).toBe('proxy_error');
      expect(body.error.message).toContain('不是 JSON API 响应');
    } finally {
      await app.close();
    }
  });

  it('Anthropic 原生流式收到 OpenAI SSE 会转换为 Anthropic SSE', async () => {
    const cfgPath = writeConfig(anthropicConfig());
    const encoder = new TextEncoder();

    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","model":"gpt-upstream","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
          'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n' +
          'data: [DONE]\n\n'
        ));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    })) as typeof fetch;

    const app = await createMigratedApp(cfgPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/messages',
        payload: {
          model: 'claude-client',
          max_tokens: 16,
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('event: message_start');
      expect(response.body).toContain('"id":"msg_');
      expect(response.body).not.toContain('chatcmpl-stream');
      expect(response.body).toContain('event: content_block_delta');
      expect(response.body).toContain('"index":0');
      expect(response.body).toContain('"text":"hi"');
      expect(response.body).toContain('"input_tokens":3');
      expect(response.body).toContain('"output_tokens":4');
      expect(response.body).toContain('event: message_stop');
    } finally {
      await app.close();
    }
  });
});
