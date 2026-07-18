/**
 * 处理上游为 OpenAI 兼容协议时的 /v1/messages 请求。
 *
 * - 把 Anthropic 请求转为 OpenAI 兼容 payload
 * - 非流式：上游返回的 JSON 可能是 Anthropic 形态（oneapi 类网关）也可能是 OpenAI 形态，
 *           分支处理，最后统一输出 Anthropic JSON
 * - 流式：用 bridgeOpenAIStreamToAnthropic 桥接为 Anthropic SSE
 */

import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AnthropicMessagesRequest, ResolvedProvider, ResolvedRoute } from '../../models.js';
import type { ApiKeyRotator } from '../../services/api-key-rotator.js';
import { createSseSession, sendUpstreamErrorResponse, writeStreamHeaders } from '../../services/passthrough.js';
import {
  ensureAnthropicJsonShape,
  extractAnthropicUsageTokens,
  isPlainObject,
  toNonNegInt,
} from '../../services/passthrough/anthropic-shape.js';
import { bridgeOpenAIStreamToAnthropic } from '../../services/stream-bridge.js';
import { anthropicToOpenAIMessages, anthropicToolsToOpenAI, openAIToAnthropicResponse } from '../../services/transformers.js';
import { setForwardResponseHeaders } from '../../services/http-headers.js';
import { releaseUpstreamResponse, safeJson } from '../../services/upstream.js';
import { createId } from '../../utils/id.js';
import { log } from '../../utils/logger.js';

export async function handleOpenAICompatibleMessages(
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
    const inputTokens = isPlainObject(body.usage) ? toNonNegInt(body.usage.input_tokens) : 0;
    const outputTokens = isPlainObject(body.usage) ? toNonNegInt(body.usage.output_tokens) : 0;
    app.metricsRegistry.recordTokens(provider.provider_type, 'input', inputTokens);
    app.metricsRegistry.recordTokens(provider.provider_type, 'output', outputTokens);
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
      input_tokens: inputTokens,
      output_tokens: outputTokens,
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
  const sse = createSseSession(reply, output, provider);
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
    idleTimeoutMs: sse.idleTimeoutMs,
    isClientClosed: sse.isClientClosed,
    clientAbortSignal: sse.clientAbortSignal,
    onUsage: ({ inputTokens, outputTokens }) => {
      app.metricsRegistry.recordTokens(provider.provider_type, 'input', inputTokens);
      app.metricsRegistry.recordTokens(provider.provider_type, 'output', outputTokens);
    },
  }).finally(sse.cleanup);
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
