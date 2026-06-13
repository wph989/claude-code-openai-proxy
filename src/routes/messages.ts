import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { verifyProxyAuth } from '../auth.js';
import { settings } from '../config.js';
import type { AnthropicMessagesRequest, CountTokensRequest, ResolvedProvider, ResolvedRoute } from '../models.js';
import type { ApiKeyRotator } from '../services/api-key-rotator.js';
import {
  buildAnthropicPassthroughPayload,
  pipeAnthropicSseWithRepair,
  sendAnthropicPassthroughResponse,
  sendUpstreamErrorResponse,
  writeStreamHeaders,
} from '../services/passthrough.js';
import { bridgeOpenAIStreamToAnthropic } from '../services/stream-bridge.js';
import { anthropicToOpenAIMessages, anthropicToolsToOpenAI, openAIToAnthropicResponse } from '../services/transformers.js';
import { setForwardResponseHeaders } from '../services/http-headers.js';
import { releaseUpstreamResponse, safeJson } from '../services/upstream.js';
import { createId } from '../utils/id.js';
import { log } from '../utils/logger.js';

export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/models', async (request, reply) => {
    if (!(await verifyProxyAuth(request, reply))) return;
    return {
      object: 'list',
      data: app.runtimeConfigManager.listModels(),
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
          anthropicBeta,
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
          anthropicBeta,
        });
      }

      log('info', '根据上游响应获取输入 token 完成', {
        provider_id: provider.provider_id,
        client_model: modelName,
        upstream_model: route.upstream_model,
        input_tokens: tokens,
        output_tokens: 0,
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
      request_body: payload,
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
        anthropicBeta,
      });
    }

    return handleOpenAICompatibleMessages(app, reply, {
      payload,
      route,
      provider,
      rotator,
      requestId,
      sessionId,
      incomingHeaders: request.headers as Record<string, string | string[] | undefined>,
      anthropicVersion,
      anthropicBeta,
    });
  });
}

async function handleAnthropicPassthrough(
  app: FastifyInstance,
  reply: FastifyReply,
  params: {
    payload: AnthropicMessagesRequest;
    route: ResolvedRoute;
    provider: ResolvedProvider;
    rotator?: ApiKeyRotator;
    requestId: string;
    sessionId: string;
    incomingHeaders?: Record<string, string | string[] | undefined>;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }
): Promise<unknown> {
  const { payload, route, provider, rotator, requestId, sessionId, incomingHeaders, anthropicVersion, anthropicBeta } = params;
  const upstreamPayload = buildAnthropicPassthroughPayload(payload, route);
  const upstreamResponse = await app.upstreamService.postMessages({
    provider,
    route,
    rotator,
    payload: upstreamPayload,
    requestId,
    sessionId,
    incomingHeaders,
    anthropicVersion,
    anthropicBeta,
  });

  if (payload.stream !== true) {
    return sendAnthropicPassthroughResponse({
      reply,
      upstreamResponse,
      fallbackModel: payload.model,
      context: {
        requestId,
        sessionId,
        providerId: provider.provider_id,
        clientModel: payload.model,
        upstreamModel: route.upstream_model,
        stream: false,
        endpoint: '/v1/messages',
      },
    });
  }

  if (!upstreamResponse.ok) {
    return sendUpstreamErrorResponse(reply, upstreamResponse, {
      requestId,
      sessionId,
      providerId: provider.provider_id,
      clientModel: payload.model,
      upstreamModel: route.upstream_model,
      stream: true,
      endpoint: '/v1/messages',
    });
  }

  const output = new PassThrough();
  writeStreamHeaders(reply, upstreamResponse);
  output.pipe(reply.raw);

  let clientClosed = false;
  const clientAbort = new AbortController();
  const onClientClose = () => {
    clientClosed = true;
    clientAbort.abort();
    output.destroy();
  };
  reply.raw.once('close', onClientClose);

  const idleTimeoutMs = Math.max(1000, provider.stream_idle_timeout_seconds * 1000 || settings.streamIdleTimeoutMs);
  void pipeAnthropicSseWithRepair({
    upstreamResponse,
    output,
    metrics: {
      requestId,
      sessionId,
      providerId: provider.provider_id,
      clientModel: payload.model,
      upstreamModel: route.upstream_model,
      endpoint: '/v1/messages',
    },
    idleTimeoutMs,
    isClientClosed: () => clientClosed,
    clientAbortSignal: clientAbort.signal,
  }).finally(() => {
    reply.raw.off('close', onClientClose);
  });
}

async function handleOpenAICompatibleMessages(
  app: FastifyInstance,
  reply: FastifyReply,
  params: {
    payload: AnthropicMessagesRequest;
    route: ResolvedRoute;
    provider: ResolvedProvider;
    rotator?: ApiKeyRotator;
    requestId: string;
    sessionId: string;
    incomingHeaders?: Record<string, string | string[] | undefined>;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }
): Promise<unknown> {
  const { payload, route, provider, rotator, requestId, sessionId, incomingHeaders, anthropicVersion, anthropicBeta } = params;
  const openAIPayload = buildOpenAICompatiblePayload(payload, route);

  const upstreamResponse = await app.upstreamService.postChatCompletions({
    provider,
    route,
    rotator,
    payload: openAIPayload,
    requestId,
    sessionId,
    incomingHeaders,
    anthropicVersion,
    anthropicBeta,
  });

  if (payload.stream !== true) {
    if (!upstreamResponse.ok) {
      return sendUpstreamErrorResponse(reply, upstreamResponse, {
        requestId,
        sessionId,
        providerId: provider.provider_id,
        clientModel: payload.model,
        upstreamModel: route.upstream_model,
        stream: false,
        endpoint: '/v1/messages',
      });
    }

    const data = await safeJson(upstreamResponse);
    // oneapi 这类网关可能已经返回 Anthropic JSON；此时只兜底补字段，避免误走 OpenAI 转换。
    const isAnthropicJson = isPlainObject(data) && data.type === 'message';
    let body: Record<string, unknown>;
    let usageTokens: number;
    if (isAnthropicJson) {
      body = ensureAnthropicJsonShape(data, payload.model);
      usageTokens = extractAnthropicUsageTokens(body.usage);
    } else {
      const converted = openAIToAnthropicResponse(payload.model, data);
      body = converted.body;
      usageTokens = (converted.usage.input_tokens || 0) + (converted.usage.output_tokens || 0);
    }

    releaseUpstreamResponse(upstreamResponse, { requests: 1, tokens: usageTokens });
    setForwardResponseHeaders(reply, upstreamResponse);
    log('info', '非流式响应完成', {
      provider_id: provider.provider_id,
      client_model: payload.model,
      upstream_model: route.upstream_model,
      upstream_status: upstreamResponse.status,
      downstream_status: upstreamResponse.status,
      stream: false,
      response_kind: isAnthropicJson ? 'anthropic-json' : 'openai-json',
      response_id: body.id,
      stop_reason: body.stop_reason ?? null,
      input_tokens: isPlainObject(body.usage) ? toNonNegInt(body.usage.input_tokens) : 0,
      output_tokens: isPlainObject(body.usage) ? toNonNegInt(body.usage.output_tokens) : 0,
      content_blocks: Array.isArray(body.content) ? body.content.length : 0,
      response_body: body,
    });
    return reply.code(upstreamResponse.status).send(body);
  }

  if (!upstreamResponse.ok) {
    return sendUpstreamErrorResponse(reply, upstreamResponse, {
      requestId,
      sessionId,
      providerId: provider.provider_id,
      clientModel: payload.model,
      upstreamModel: route.upstream_model,
      stream: true,
      endpoint: '/v1/messages',
    });
  }

  const output = new PassThrough();
  const messageId = createId('msg');
  writeStreamHeaders(reply, upstreamResponse);
  output.pipe(reply.raw);

  // 客户端断开时主动 abort 上游 reader，避免流式 lease 一直占用。
  let clientClosed = false;
  const clientAbort = new AbortController();
  const onClientClose = () => {
    clientClosed = true;
    clientAbort.abort();
    output.destroy();
  };
  reply.raw.once('close', onClientClose);

  const idleTimeoutMs = Math.max(1000, provider.stream_idle_timeout_seconds * 1000 || settings.streamIdleTimeoutMs);
  const metrics = {
    requestId,
    sessionId,
    providerId: provider.provider_id,
    clientModel: payload.model,
    upstreamModel: route.upstream_model,
    endpoint: '/v1/messages',
  };

  void bridgeOpenAIStreamToAnthropic({
    upstreamResponse,
    output,
    clientModel: payload.model,
    messageId,
    metrics,
    idleTimeoutMs,
    isClientClosed: () => clientClosed,
    clientAbortSignal: clientAbort.signal,
  }).finally(() => {
    reply.raw.off('close', onClientClose);
  });
}

function buildOpenAICompatiblePayload(payload: AnthropicMessagesRequest, route: ResolvedRoute): Record<string, unknown> {
  const openAIPayload: Record<string, unknown> = {
    model: route.upstream_model,
    messages: anthropicToOpenAIMessages(payload.system, payload.messages as unknown as Array<Record<string, unknown>>),
    max_tokens: payload.max_tokens ?? 4096,
    stream: payload.stream === true,
    ...route.extra_body,
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
    openAIPayload.stream_options = {
      include_usage: true,
      ...(isPlainObject(openAIPayload.stream_options) ? openAIPayload.stream_options as Record<string, unknown> : {}),
    };
  }
  return openAIPayload;
}

export async function pipeUpstreamSse(params: {
  upstreamResponse: Response;
  output: PassThrough;
  requestId: string;
  sessionId: string;
  providerId: string;
  clientModel: string;
  upstreamModel: string;
  idleTimeoutMs: number;
  isClientClosed?: () => boolean;
  clientAbortSignal?: AbortSignal;
}): Promise<void> {
  const { upstreamResponse, output, requestId, sessionId, providerId, clientModel, upstreamModel, idleTimeoutMs, isClientClosed, clientAbortSignal } = params;
  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text();
    output.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: errorText || `上游请求失败，状态码=${upstreamResponse.status}` } })}\n\n`);
    releaseUpstreamResponse(upstreamResponse);
    output.end();
    return;
  }

  await pipeAnthropicSseWithRepair({
    upstreamResponse,
    output,
    metrics: { requestId, sessionId, providerId, clientModel, upstreamModel, endpoint: '/v1/messages' },
    idleTimeoutMs,
    isClientClosed,
    clientAbortSignal,
  });
}

function buildAnthropicError(requestId: string, errorType: string, message: string): Record<string, unknown> {
  return {
    type: 'error',
    error: {
      type: errorType,
      message,
    },
    request_id: requestId,
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

function ensureAnthropicJsonShape(data: Record<string, unknown>, fallbackModel: string): Record<string, unknown> {
  if (data.type !== 'message') data.type = 'message';
  if (data.role !== 'assistant') data.role = 'assistant';
  if (typeof data.id !== 'string' || !data.id || data.id.startsWith('chatcmpl-')) {
    data.id = createId('msg');
  }
  if (typeof data.model !== 'string' || !data.model) data.model = fallbackModel;
  if (!Array.isArray(data.content)) data.content = [];
  if (data.stop_reason === undefined) data.stop_reason = null;
  if (data.stop_sequence === undefined) data.stop_sequence = null;
  const usage = (isPlainObject(data.usage) ? data.usage : {}) as Record<string, unknown>;
  usage.input_tokens = toNonNegInt(usage.input_tokens);
  usage.cache_creation_input_tokens = toNonNegInt(usage.cache_creation_input_tokens);
  usage.cache_read_input_tokens = toNonNegInt(usage.cache_read_input_tokens);
  usage.output_tokens = Math.max(1, toNonNegInt(usage.output_tokens));
  usage.server_tool_use = usage.server_tool_use ?? null;
  data.usage = usage;
  return data;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toInt(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}

function toNonNegInt(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : 0;
}
