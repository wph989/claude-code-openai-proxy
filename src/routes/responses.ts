import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { proxyAuthHook } from '../auth.js';
import { setForwardResponseHeaders } from '../services/http-headers.js';
import { createSseSession, sendUpstreamErrorResponse, writeStreamHeaders } from '../services/passthrough.js';
import { releaseUpstreamResponse, safeJson } from '../services/upstream.js';
import { isPlainObject, toNonNegInt } from '../utils/guards.js';
import { log } from '../utils/logger.js';
import { pipeOpenAISse } from './chat-completions.js';

/**
 * OpenAI Responses API 只做协议原样透传；Provider 是否实现该端点由显式能力矩阵决定。
 * 这样不会把“支持 Chat Completions”误推断为“支持完整 OpenAI API”。
 */
export async function registerResponsesRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/responses', { preHandler: [proxyAuthHook] }, async (request, reply) => {
    const payload = isPlainObject(request.body) ? request.body : {};
    const modelName = String(payload.model || app.runtimeConfigManager.getDefaultClientModel() || '').trim();
    if (!modelName) {
      return reply.code(400).send(openAIError('model 不能为空，且未配置 default_client_model。'));
    }

    let resolved;
    try {
      resolved = app.runtimeConfigManager.resolveModel(modelName, 'responses');
    } catch (error) {
      return reply.code(400).send(openAIError(error instanceof Error ? error.message : '模型映射失败。'));
    }

    const { route, provider, rotator } = resolved;
    const upstreamPayload: Record<string, unknown> = {
      ...payload,
      ...route.extra_body,
      // 模型映射必须最后写入，避免客户端或 extra_body 绕过配置选择任意上游模型。
      model: route.upstream_model,
    };
    const stream = upstreamPayload.stream === true;

    log('info', '收到 OpenAI Responses 请求', {
      provider_id: provider.provider_id,
      stream,
    });

    const upstreamResponse = await app.upstreamService.postResponses({
      provider,
      route,
      rotator,
      payload: upstreamPayload,
      requestId: request.requestId,
      sessionId: request.sessionId,
      incomingHeaders: request.headers as Record<string, string | string[] | undefined>,
    });

    const context = {
      providerId: provider.provider_id,
      stream,
      endpoint: '/v1/responses',
    };
    if (!upstreamResponse.ok) {
      return sendUpstreamErrorResponse(reply, upstreamResponse, context);
    }

    if (!stream) {
      const data = await safeJson(upstreamResponse);
      const usage = extractResponsesUsage(data);
      releaseUpstreamResponse(upstreamResponse, {
        requests: 1,
        tokens: usage.inputTokens + usage.outputTokens,
        ...usage,
      });
      app.metricsRegistry.recordTokens(provider.provider_type, 'input', usage.inputTokens);
      app.metricsRegistry.recordTokens(provider.provider_type, 'output', usage.outputTokens);
      // 对外始终保持客户端模型别名，避免泄露内部上游模型映射。
      if (typeof data.model === 'string') data.model = modelName;
      setForwardResponseHeaders(reply, upstreamResponse);
      log('info', 'OpenAI Responses 非流式透传完成', {
        provider_id: provider.provider_id,
        upstream_status: upstreamResponse.status,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
      });
      return reply.code(upstreamResponse.status).send(data);
    }

    const output = new PassThrough();
    writeStreamHeaders(reply, upstreamResponse);
    output.pipe(reply.raw);
    const sse = createSseSession(reply, output, provider);
    void pipeOpenAISse({
      upstreamResponse,
      output,
      requestId: request.requestId,
      sessionId: request.sessionId,
      providerId: provider.provider_id,
      clientModel: modelName,
      upstreamModel: route.upstream_model,
      idleTimeoutMs: sse.idleTimeoutMs,
      isClientClosed: sse.isClientClosed,
      clientAbortSignal: sse.clientAbortSignal,
      protocol: 'responses',
      onUsage: ({ inputTokens, outputTokens }) => {
        app.metricsRegistry.recordTokens(provider.provider_type, 'input', inputTokens);
        app.metricsRegistry.recordTokens(provider.provider_type, 'output', outputTokens);
      },
    }).finally(sse.cleanup);
  });
}

function extractResponsesUsage(data: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
} {
  const usage = isPlainObject(data.usage) ? data.usage : {};
  return {
    inputTokens: toNonNegInt(usage.input_tokens),
    outputTokens: toNonNegInt(usage.output_tokens),
  };
}

function openAIError(message: string): Record<string, unknown> {
  return {
    error: {
      type: 'invalid_request_error',
      message,
    },
  };
}
