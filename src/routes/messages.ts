import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { verifyProxyAuth } from '../auth.js';
import { settings } from '../config.js';
import type { AnthropicMessagesRequest, CountTokensRequest } from '../models.js';
import { bridgeOpenAIStreamToAnthropic } from '../services/stream-bridge.js';
import { anthropicToOpenAIMessages, anthropicToolsToOpenAI, openAIToAnthropicResponse } from '../services/transformers.js';
import { releaseUpstreamResponse, safeJson } from '../services/upstream.js';
import { createId } from '../utils/id.js';
import { log, logDetailed } from '../utils/logger.js';

export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/models', async (request, reply) => {
    if (!(await verifyProxyAuth(request, reply))) return;
    return {
      object: 'list',
      data: app.runtimeConfigManager.listModels()
    };
  });

  app.post('/v1/messages/count_tokens', async (request, reply) => {
    if (!(await verifyProxyAuth(request, reply))) return;
    const payload = (request.body || {}) as CountTokensRequest;
    const requestId = request.requestId;
    const sessionId = request.sessionId;
    const modelName = String(payload.model || app.runtimeConfigManager.getConfig().default_client_model || '').trim();
    if (!modelName) {
      return reply.code(400).send(buildAnthropicError(requestId, 'invalid_request_error', 'count_tokens 需要 model，且当前未配置 default_client_model。'));
    }

    try {
      const { route, provider, rotator } = app.runtimeConfigManager.resolveModel(modelName);
      const anthropicVersion = readHeader(request.headers['anthropic-version']);
      const anthropicBeta = readHeader(request.headers['anthropic-beta']);

      let tokens: number;
      if (provider.provider_type === 'anthropic') {
        tokens = await app.upstreamService.countTokensAnthropic({
          provider,
          route,
          rotator,
          anthropicPayload: { messages: payload.messages, system: payload.system },
          requestId,
          sessionId,
          anthropicVersion,
          anthropicBeta
        });
      } else {
        const openAIMessages = anthropicToOpenAIMessages(payload.system, payload.messages as unknown as Array<Record<string, unknown>>);
        tokens = await app.upstreamService.countTokensViaProviderResponse({
          provider,
          route,
          rotator,
          openAIMessages,
          requestId,
          sessionId,
          anthropicVersion,
          anthropicBeta
        });
      }
      log('info', '根据上游响应获取输入 token 完成', {
        provider_id: provider.provider_id,
        client_model: modelName,
        upstream_model: route.upstream_model,
        input_tokens: tokens,
        output_tokens: 0
      });
      return { input_tokens: tokens };
    } catch (error) {
      return reply.code(400).send(buildAnthropicError(requestId, 'invalid_request_error', error instanceof Error ? error.message : 'count_tokens 失败。'));
    }
  });

  app.post('/v1/messages', async (request, reply) => {
    if (!(await verifyProxyAuth(request, reply))) return;
    const payload = (request.body || {}) as AnthropicMessagesRequest;
    const requestId = request.requestId;
    const sessionId = request.sessionId;

    let resolved;
    try {
      resolved = app.runtimeConfigManager.resolveModel(payload.model);
    } catch (error) {
      return reply.code(400).send(buildAnthropicError(requestId, 'invalid_request_error', error instanceof Error ? error.message : '模型映射失败。'));
    }

    const { route, provider, rotator } = resolved;
    const anthropicVersion = readHeader(request.headers['anthropic-version']);
    const anthropicBeta = readHeader(request.headers['anthropic-beta']);

    log('info', '收到 Claude Code 请求', {
      provider_id: provider.provider_id,
      provider_type: provider.provider_type,
      client_model: payload.model,
      upstream_model: route.upstream_model,
      stream: payload.stream === true,
      request_body: payload
    });

    if (provider.provider_type === 'anthropic') {
      return handleAnthropicPassthrough(app, reply, {
        payload,
        route,
        provider,
        rotator,
        requestId,
        sessionId,
        incomingHeaders: request.headers as Record<string, string | string[] | undefined>,
        anthropicVersion,
        anthropicBeta
      });
    }

    const openAIPayload: Record<string, unknown> = {
      model: route.upstream_model,
      messages: anthropicToOpenAIMessages(payload.system, payload.messages as unknown as Array<Record<string, unknown>>),
      max_tokens: payload.max_tokens ?? 4096,
      stream: payload.stream === true
    };
    if (payload.temperature != null) {
      openAIPayload.temperature = payload.temperature;
    }
    if (payload.top_p != null) {
      openAIPayload.top_p = payload.top_p;
    }
    if (payload.stop_sequences?.length) {
      openAIPayload.stop = payload.stop_sequences;
    }
    const tools = anthropicToolsToOpenAI(payload.tools as unknown as Array<Record<string, unknown>> | undefined);
    if (tools?.length) {
      openAIPayload.tools = tools;
    }
    if (openAIPayload.stream === true) {
      openAIPayload.stream_options = { include_usage: true };
    }

    if (payload.stream !== true) {
      const upstreamResponse = await app.upstreamService.postChatCompletions({
        provider,
        route,
        rotator,
        payload: openAIPayload,
        requestId,
        sessionId,
        incomingHeaders: request.headers as Record<string, string | string[] | undefined>,
        anthropicVersion,
        anthropicBeta
      });
      const data = await safeJson(upstreamResponse);
      if (!upstreamResponse.ok) {
        return reply.code(upstreamResponse.status).send(data);
      }
      const { body, usage } = openAIToAnthropicResponse(payload.model, data);
      releaseUpstreamResponse(upstreamResponse, { requests: 1, tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) });
      log('info', '非流式响应完成', {
        provider_id: provider.provider_id,
        client_model: payload.model,
        upstream_model: route.upstream_model,
        upstream_status: upstreamResponse.status,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        response_body: body
      });
      return body;
    }

    const messageId = createId('msg');
    const upstreamResponse = await app.upstreamService.postChatCompletions({
      provider,
      route,
      rotator,
      payload: openAIPayload,
      requestId,
      sessionId,
      incomingHeaders: request.headers as Record<string, string | string[] | undefined>,
      anthropicVersion,
      anthropicBeta
    });

    const output = new PassThrough();
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    });
    output.pipe(reply.raw);

    // 客户端断开时取消上游 body，让 bridge 的 finally 释放 lease，避免 activeRequests 泄漏。
    const onClientClose = () => {
      try { upstreamResponse.body?.cancel().catch(() => {}); } catch { /* noop */ }
      output.destroy();
    };
    reply.raw.once('close', onClientClose);

    void bridgeOpenAIStreamToAnthropic({
      upstreamResponse,
      output,
      clientModel: payload.model,
      messageId,
      metrics: {
        requestId,
        sessionId,
        providerId: provider.provider_id,
        clientModel: payload.model,
        upstreamModel: route.upstream_model
      },
      idleTimeoutMs: Math.max(1000, provider.stream_idle_timeout_seconds * 1000 || settings.streamIdleTimeoutMs)
    }).finally(() => {
      reply.raw.off('close', onClientClose);
    });
  });
}

async function handleAnthropicPassthrough(
  app: FastifyInstance,
  reply: FastifyReply,
  params: {
    payload: AnthropicMessagesRequest;
    route: { client_model: string; upstream_model: string; extra_body: Record<string, unknown> };
    provider: { provider_id: string; stream_idle_timeout_seconds: number };
    rotator: unknown;
    requestId: string;
    sessionId: string;
    incomingHeaders?: Record<string, string | string[] | undefined>;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }
): Promise<unknown> {
  const { payload, route, provider, rotator, requestId, sessionId, incomingHeaders, anthropicVersion, anthropicBeta } = params;

  const upstreamPayload: Record<string, unknown> = {
    ...(payload as unknown as Record<string, unknown>),
    model: route.upstream_model,
    ...route.extra_body
  };

  const upstreamResponse = await app.upstreamService.postMessages({
    provider: provider as Parameters<typeof app.upstreamService.postMessages>[0]['provider'],
    route: route as Parameters<typeof app.upstreamService.postMessages>[0]['route'],
    rotator: rotator as Parameters<typeof app.upstreamService.postMessages>[0]['rotator'],
    payload: upstreamPayload,
    requestId,
    sessionId,
    incomingHeaders,
    anthropicVersion,
    anthropicBeta
  });

  if (payload.stream !== true) {
    const data = await safeJson(upstreamResponse);
    if (!upstreamResponse.ok) {
      return reply.code(upstreamResponse.status).send(data);
    }
    if (data.model) data.model = payload.model;
    releaseUpstreamResponse(upstreamResponse, { requests: 1, tokens: extractAnthropicUsageTokens(data.usage) });
    log('info', 'Anthropic 透传响应完成', {
      provider_id: provider.provider_id,
      client_model: payload.model,
      upstream_model: route.upstream_model
    });
    return data;
  }

  const output = new PassThrough();
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });
  output.pipe(reply.raw);

  const idleTimeoutMs = Math.max(1000, provider.stream_idle_timeout_seconds * 1000 || settings.streamIdleTimeoutMs);
  void pipeUpstreamSse({ upstreamResponse, output, requestId, sessionId, providerId: provider.provider_id, clientModel: payload.model, upstreamModel: route.upstream_model, idleTimeoutMs });
}

async function pipeUpstreamSse(params: {
  upstreamResponse: Response;
  output: PassThrough;
  requestId: string;
  sessionId: string;
  providerId: string;
  clientModel: string;
  upstreamModel: string;
  idleTimeoutMs: number;
}): Promise<void> {
  const { upstreamResponse, output, requestId, sessionId, providerId, clientModel, upstreamModel, idleTimeoutMs } = params;
  try {
    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      output.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: errorText || `上游请求失败，状态码=${upstreamResponse.status}` } })}\n\n`);
      output.end();
      return;
    }

    const body = upstreamResponse.body;
    if (!body) { output.end(); return; }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout>;
        const readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`SSE idle timeout: ${idleTimeoutMs}ms`)), idleTimeoutMs); })
        ]);
        clearTimeout(timer!);
        const { value, done } = readResult;
        if (done) break;
        output.write(value);
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    log('info', 'Anthropic 流式透传完成', {
      provider_id: providerId,
      client_model: clientModel,
      upstream_model: upstreamModel
    });
  } catch (error) {
    log('error', '流式透传失败', { error });
    output.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: '流式透传失败。' } })}\n\n`);
  } finally {
    releaseUpstreamResponse(upstreamResponse);
    output.end();
  }
}

function buildAnthropicError(requestId: string, errorType: string, message: string): Record<string, unknown> {
  return {
    type: 'error',
    error: {
      type: errorType,
      message
    },
    request_id: requestId
  };
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function extractAnthropicUsageTokens(value: unknown): number {
  if (!isPlainObject(value)) return 0;
  // Anthropic 原生响应没有 total_tokens 字段，只能用输入/输出相加来驱动本地配额守护。
  return toInt(value.input_tokens) + toInt(value.output_tokens);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toInt(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}
