/**
 * 处理上游为 Anthropic 原生协议时的 /v1/messages 请求。
 *
 * 非流式：透传 + JSON 兜底字段补齐
 * 流式：peek + 修复管线（OpenAI-SSE→Anthropic、半成品 Anthropic SSE → 修复、其他原样转发）
 */

import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AnthropicMessagesRequest, ResolvedProvider, ResolvedRoute } from '../../models.js';
import type { ApiKeyRotator } from '../../services/api-key-rotator.js';
import {
  buildAnthropicPassthroughPayload,
  createSseSession,
  pipeAnthropicSseWithRepair,
  sendAnthropicPassthroughResponse,
  sendUpstreamErrorResponse,
  writeStreamHeaders,
} from '../../services/passthrough.js';

export async function handleAnthropicPassthrough(
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
      onUsage: ({ inputTokens, outputTokens }) => {
        app.metricsRegistry.recordTokens(provider.provider_type, 'input', inputTokens);
        app.metricsRegistry.recordTokens(provider.provider_type, 'output', outputTokens);
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
  const sse = createSseSession(reply, output, provider);
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
    idleTimeoutMs: sse.idleTimeoutMs,
    isClientClosed: sse.isClientClosed,
    clientAbortSignal: sse.clientAbortSignal,
    onUsage: ({ inputTokens, outputTokens }) => {
      app.metricsRegistry.recordTokens(provider.provider_type, 'input', inputTokens);
      app.metricsRegistry.recordTokens(provider.provider_type, 'output', outputTokens);
    },
  }).finally(sse.cleanup);
}
