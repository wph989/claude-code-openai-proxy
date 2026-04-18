import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { verifyProxyAuth } from '../auth.js';
import { settings } from '../config.js';
import type { AnthropicMessagesRequest, CountTokensRequest } from '../models.js';
import { bridgeOpenAIStreamToAnthropic } from '../services/stream-bridge.js';
import { anthropicToOpenAIMessages, anthropicToolsToOpenAI, openAIToAnthropicResponse } from '../services/transformers.js';
import { safeJson } from '../services/upstream.js';
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
      const { route, provider } = app.runtimeConfigManager.resolveModel(modelName);
      const openAIMessages = anthropicToOpenAIMessages(payload.system, payload.messages as unknown as Array<Record<string, unknown>>);
      const tokens = await app.upstreamService.countTokensViaProviderResponse({
        provider,
        route,
        openAIMessages,
        requestId,
        sessionId,
        anthropicVersion: readHeader(request.headers['anthropic-version']),
        anthropicBeta: readHeader(request.headers['anthropic-beta'])
      });
      log('info', '根据上游响应获取输入 token 完成', {
        request_id: requestId,
        session_id: sessionId,
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

    const { route, provider } = resolved;
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

    log('info', '收到 Claude Code 请求', {
      request_id: requestId,
      session_id: sessionId,
      provider_id: provider.provider_id,
      client_model: payload.model,
      upstream_model: route.upstream_model,
      stream: payload.stream === true,
      request_body: payload
    });

    const anthropicVersion = readHeader(request.headers['anthropic-version']);
    const anthropicBeta = readHeader(request.headers['anthropic-beta']);

    if (payload.stream !== true) {
      const upstreamResponse = await app.upstreamService.postChatCompletions({
        provider,
        route,
        payload: openAIPayload,
        requestId,
        sessionId,
        anthropicVersion,
        anthropicBeta
      });
      const data = await safeJson(upstreamResponse);
      if (!upstreamResponse.ok) {
        return reply.code(upstreamResponse.status).send(data);
      }
      const { body, usage } = openAIToAnthropicResponse(payload.model, data);
      log('info', '非流式响应完成', {
        request_id: requestId,
        session_id: sessionId,
        provider_id: provider.provider_id,
        client_model: payload.model,
        upstream_model: route.upstream_model,
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
      payload: openAIPayload,
      requestId,
      sessionId,
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
      }
    });
  });
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
