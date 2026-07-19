/**
 * /v1/messages、/v1/messages/count_tokens、/v1/models 三条路由。
 *
 * 路由层只做：鉴权 → 模型解析 → 分流到 anthropic-handler / openai-handler。
 * 具体协议转换、SSE 处理放在子模块或 services/ 下。
 */

import type { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { proxyAuthHook } from '../auth.js';
import type { AnthropicMessagesRequest, CountTokensRequest } from '../models.js';
import { pipeAnthropicSseWithRepair } from '../services/passthrough.js';
import { anthropicToOpenAIMessages } from '../services/transformers.js';
import { releaseUpstreamResponse } from '../services/upstream.js';
import { log } from '../utils/logger.js';
import { handleAnthropicPassthrough } from './messages/anthropic-handler.js';
import { handleOpenAICompatibleMessages } from './messages/openai-handler.js';

export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/models', { preHandler: [proxyAuthHook] }, async () => {
    return {
      object: 'list',
      data: app.runtimeConfigManager.listModels(),
    };
  });

  app.post('/v1/messages/count_tokens', { preHandler: [proxyAuthHook] }, async (request, reply) => {
    const payload = (request.body || {}) as CountTokensRequest;
    const requestId = request.requestId;
    const sessionId = request.sessionId;
    const modelName = String(payload.model || app.runtimeConfigManager.getDefaultClientModel() || '').trim();
    if (!modelName) {
      return reply.code(400).send(buildAnthropicError(requestId, 'invalid_request_error', 'count_tokens 需要 model，且当前未配置 default_client_model。'));
    }

    try {
      const { route, provider, rotator } = app.runtimeConfigManager.resolveModel(modelName, 'count_tokens');
      request.clientModel = modelName;
      request.upstreamModel = route.upstream_model;
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

  app.post('/v1/messages', { preHandler: [proxyAuthHook] }, async (request, reply) => {
    const payload = (request.body || {}) as AnthropicMessagesRequest;
    const requestId = request.requestId;
    const sessionId = request.sessionId;

    let resolved;
    try {
      resolved = app.runtimeConfigManager.resolveModel(payload.model, 'messages');
    } catch (error) {
      return reply.code(400).send(buildAnthropicError(requestId, 'invalid_request_error', error instanceof Error ? error.message : '模型映射失败。'));
    }

    const { route, provider, rotator } = resolved;
    request.clientModel = payload.model;
    request.upstreamModel = route.upstream_model;
    const anthropicVersion = readHeader(request.headers['anthropic-version']);
    const anthropicBeta = readHeader(request.headers['anthropic-beta']);

    log('info', '收到 Claude Code 请求', {
      provider_id: provider.provider_id,
      provider_type: provider.provider_type,
      client_model: payload.model,
      upstream_model: route.upstream_model,
      stream: payload.stream === true,
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

/**
 * SSE 管线测试用便捷入口：上游非 200 时先吐 error 事件，否则委托给 pipeAnthropicSseWithRepair。
 *
 * 生产路径走 handleAnthropicPassthrough；保留此函数是为了让 stream-failure 测试可以
 * 在路由层之外直接驱动管线，验证客户端断开、流中错误等边界场景。
 */
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
