import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createMigratedApp } from './test-app.js';

let tempDir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'ccop-responses-'));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('OpenAI Responses API', () => {
  it('非流式请求使用显式能力、上游模型和现有 Key/费用统计链路', async () => {
    const configPath = writeConfig(true, true);
    const captured: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        url: String(input),
        body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({
        id: 'resp_test',
        object: 'response',
        model: 'internal-upstream-model',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      }), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '9' } });
    }) as typeof fetch;

    const app = await createMigratedApp(configPath);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: {
          model: 'public-model',
          input: 'hello',
          metadata: { source: 'test' },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['x-ratelimit-remaining']).toBe('9');
      expect(response.json()).toMatchObject({ model: 'public-model', status: 'completed' });
      expect(response.body).not.toContain('internal-upstream-model');
      expect(captured).toEqual([{
        url: 'https://example.com/v1/responses',
        body: {
          model: 'internal-upstream-model',
          input: 'hello',
          metadata: { source: 'test' },
          temperature: 0.2,
        },
        authorization: 'Bearer sk-responses-test',
      }]);
      expect(app.runtimeConfigManager.getKeyStates('responses-provider')[0].usage).toEqual({
        requests_used: 1,
        tokens_used: 16,
        input_tokens_used: 12,
        output_tokens_used: 4,
        cost_usd: 0.000064,
      });
    } finally {
      await closeApp(app);
    }
  });

  it('能力未启用时返回稳定 400，且不接触上游', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
    const app = await createMigratedApp(writeConfig(false));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: { model: 'public-model', input: 'hello' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({ type: 'invalid_request_error' });
      expect(response.json().error.message).toContain('没有启用支持 OpenAI Responses');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await closeApp(app);
    }
  });

  it('流式事件保持 Responses 语义、改写模型别名并提取嵌套 usage', async () => {
    const encoder = new TextEncoder();
    const source = [
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_stream","model":"internal-upstream-model","status":"in_progress"}}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_stream","model":"internal-upstream-model","status":"completed","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n',
    ].join('');
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = encoder.encode(source);
        controller.enqueue(bytes.subarray(0, 37));
        controller.enqueue(bytes.subarray(37));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;

    const app = await createMigratedApp(writeConfig(true, true));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        payload: { model: 'public-model', input: 'hello', stream: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('event: response.created');
      expect(response.body).toContain('event: response.completed');
      expect(response.body).toContain('"model":"public-model"');
      expect(response.body).not.toContain('internal-upstream-model');
      expect(response.body).not.toContain('[DONE]');
      expect(app.runtimeConfigManager.getKeyStates('responses-provider')[0].usage).toMatchObject({
        requests_used: 1,
        tokens_used: 10,
        input_tokens_used: 7,
        output_tokens_used: 3,
      });
    } finally {
      await closeApp(app);
    }
  });
});

function writeConfig(responses: boolean, withCost = false): string {
  const configPath = path.join(tempDir, 'runtime_models.json');
  writeFileSync(configPath, JSON.stringify({
    revision: 1,
    providers: [{
      provider_id: 'responses-provider',
      provider_type: 'openai_compatible',
      base_url: 'https://example.com/v1',
      capabilities: { responses, models: true },
      api_key: [{
        id: 'RESPKEY001',
        key: 'sk-responses-test',
        ...(withCost ? {
          quota: {
            max_requests: null,
            max_tokens: null,
            max_cost_usd: 1,
            input_cost_per_million: 2,
            output_cost_per_million: 10,
            soft_stop_threshold: 1,
          },
        } : {}),
      }],
      timeout_seconds: 30,
      stream_idle_timeout_seconds: 2,
      enabled: true,
      headers: {},
      anti_ban: { min_interval_ms: 0, retry: { max_attempts: 1, max_total_ms: 1000 } },
    }],
    models: [{
      route_id: 'RESPROUTE1',
      client_model: 'public-model',
      provider_id: 'responses-provider',
      upstream_model: 'internal-upstream-model',
      extra_body: { temperature: 0.2 },
      enabled: true,
    }],
    default_client_model: 'public-model',
  }), 'utf8');
  return configPath;
}

async function closeApp(app: FastifyInstance): Promise<void> {
  await app.runtimeConfigManager.shutdown();
  await app.close();
}
