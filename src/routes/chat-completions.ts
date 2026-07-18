import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { proxyAuthHook } from '../auth.js';
import { createSseSession, sendUpstreamErrorResponse, writeStreamHeaders } from '../services/passthrough.js';
import { SseUsageTracker, type StreamTokenUsage } from '../services/passthrough/sse-usage.js';
import { SseModelAliasRewriter } from '../services/passthrough/sse-model-alias.js';
import { isPlainObject } from '../utils/guards.js';
import { readStreamChunk } from '../services/stream-read.js';
import { setForwardResponseHeaders } from '../services/http-headers.js';
import { markUpstreamResponseStreamError, releaseUpstreamResponse, safeJson } from '../services/upstream.js';
import { log } from '../utils/logger.js';

export async function registerChatCompletionsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/chat/completions', { preHandler: [proxyAuthHook] }, async (request, reply) => {
    const payload = (request.body || {}) as Record<string, unknown>;
    const requestId = request.requestId;
    const sessionId = request.sessionId;

    const modelName = String(payload.model || app.runtimeConfigManager.getDefaultClientModel() || '').trim();
    if (!modelName) {
      return reply.code(400).send({
        error: { type: 'invalid_request_error', message: 'model 不能为空，且未配置 default_client_model。' }
      });
    }

    let route, provider, rotator;
    try {
      const resolved = app.runtimeConfigManager.resolveModel(modelName, 'chat_completions');
      route = resolved.route;
      provider = resolved.provider;
      rotator = resolved.rotator;
    } catch (error) {
      return reply.code(400).send({
        error: { type: 'invalid_request_error', message: error instanceof Error ? error.message : '模型映射失败。' }
      });
    }

    if (provider.provider_type !== 'openai_compatible') {
      return reply.code(400).send({
        error: { type: 'invalid_request_error', message: `/v1/chat/completions 仅支持 openai_compatible 供应商，当前供应商类型为 ${provider.provider_type}。` }
      });
    }

    const upstreamPayload: Record<string, unknown> = {
      ...payload,
      model: route.upstream_model,
      ...route.extra_body
    };
    if (upstreamPayload.stream === true) {
      upstreamPayload.stream_options = {
        include_usage: true,
        ...(isPlainObject(upstreamPayload.stream_options) ? upstreamPayload.stream_options as Record<string, unknown> : {})
      };
    }

    log('info', '收到 OpenAI Chat Completions 请求', {
      provider_id: provider.provider_id,
      stream: payload.stream === true
    });

    const upstreamResponse = await app.upstreamService.postChatCompletions({
      provider,
      route,
      rotator,
      payload: upstreamPayload,
      requestId,
      sessionId,
      incomingHeaders: request.headers as Record<string, string | string[] | undefined>
    });

    if (payload.stream !== true) {
      if (!upstreamResponse.ok) {
        return sendUpstreamErrorResponse(reply, upstreamResponse, {
          requestId,
          sessionId,
          providerId: provider.provider_id,
          clientModel: modelName,
          upstreamModel: route.upstream_model,
          stream: false,
          endpoint: '/v1/chat/completions'
        });
      }
      const data = await safeJson(upstreamResponse);
      const inputTokens = isPlainObject(data.usage) ? toInt(data.usage.prompt_tokens) : 0;
      const outputTokens = isPlainObject(data.usage) ? toInt(data.usage.completion_tokens) : 0;
      releaseUpstreamResponse(upstreamResponse, {
        requests: 1,
        tokens: extractOpenAIUsageTokens(data.usage),
        inputTokens,
        outputTokens,
      });
      app.metricsRegistry.recordTokens(provider.provider_type, 'input', inputTokens);
      app.metricsRegistry.recordTokens(provider.provider_type, 'output', outputTokens);
      if (data.model) data.model = modelName;
      setForwardResponseHeaders(reply, upstreamResponse);
      log('info', 'OpenAI 透传响应完成', {
        provider_id: provider.provider_id,
        upstream_status: upstreamResponse.status,
        downstream_status: upstreamResponse.status,
        stream: false,
        response_kind: 'openai-json',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: isPlainObject(data.usage) ? toInt(data.usage.total_tokens) : 0
      });
      return reply.code(upstreamResponse.status).send(data);
    }

    if (!upstreamResponse.ok) {
      return sendUpstreamErrorResponse(reply, upstreamResponse, {
        requestId,
        sessionId,
        providerId: provider.provider_id,
        clientModel: modelName,
        upstreamModel: route.upstream_model,
        stream: true,
        endpoint: '/v1/chat/completions'
      });
    }

    const output = new PassThrough();
    writeStreamHeaders(reply, upstreamResponse);
    output.pipe(reply.raw);
    const sse = createSseSession(reply, output, provider);
    void pipeOpenAISse({
      upstreamResponse,
      output,
      requestId,
      sessionId,
      providerId: provider.provider_id,
      clientModel: modelName,
      upstreamModel: route.upstream_model,
      idleTimeoutMs: sse.idleTimeoutMs,
      isClientClosed: sse.isClientClosed,
      clientAbortSignal: sse.clientAbortSignal,
      onUsage: ({ inputTokens, outputTokens }) => {
        app.metricsRegistry.recordTokens(provider.provider_type, 'input', inputTokens);
        app.metricsRegistry.recordTokens(provider.provider_type, 'output', outputTokens);
      }
    }).finally(sse.cleanup);
  });
}

export async function pipeOpenAISse(params: {
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
  onUsage?: (usage: StreamTokenUsage) => void;
  protocol?: 'chat_completions' | 'responses';
}): Promise<void> {
  const {
    upstreamResponse,
    output,
    providerId,
    idleTimeoutMs,
    isClientClosed,
    clientAbortSignal,
    onUsage,
    protocol = 'chat_completions',
  } = params;
  const usageTracker = new SseUsageTracker();
  const modelAliasRewriter = new SseModelAliasRewriter(params.upstreamModel, params.clientModel);
  try {
    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      writeOpenAIStreamError(output, protocol, errorText || `上游请求失败，状态码=${upstreamResponse.status}`);
      output.end();
      return;
    }

    const body = upstreamResponse.body;
    if (!body) { output.end(); return; }

    const reader = body.getReader();
    try {
      while (true) {
        const readResult = await readStreamChunk(reader, idleTimeoutMs, `SSE idle timeout: ${idleTimeoutMs}ms`, clientAbortSignal);
        const { value, done } = readResult;
        if (done) break;
        usageTracker.push(value);
        const rewritten = modelAliasRewriter.push(value);
        if (rewritten) output.write(rewritten);
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    const usage = usageTracker.finish();
    const trailing = modelAliasRewriter.finish();
    if (trailing) output.write(trailing);
    onUsage?.(usage);
    releaseUpstreamResponse(upstreamResponse, {
      requests: 1,
      tokens: usage.inputTokens + usage.outputTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
    log('info', protocol === 'responses' ? 'OpenAI Responses 流式透传完成' : 'OpenAI 流式透传完成', {
      provider_id: providerId,
      upstream_status: upstreamResponse.status,
      downstream_status: upstreamResponse.status,
      stream: true,
      sse_kind: protocol === 'responses' ? 'openai-responses-sse-raw' : 'openai-chat-sse-raw',
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens
    });
  } catch (error) {
    const clientClosed = isClientClosed?.() === true;
    if (!clientClosed) {
      const message = error instanceof Error ? error.message : String(error);
      markUpstreamResponseStreamError(upstreamResponse, message, 'network');
    }
    if (clientClosed) {
      log('info', '客户端断开，停止 OpenAI 流式透传', {
        provider_id: providerId
      });
      return;
    }
    log('error', 'OpenAI 流式透传失败', { error });
    writeOpenAIStreamError(output, protocol, '流式透传失败。');
  } finally {
    releaseUpstreamResponse(upstreamResponse);
    output.end();
  }
}

function writeOpenAIStreamError(
  output: PassThrough,
  protocol: 'chat_completions' | 'responses',
  message: string,
): void {
  const error = { type: 'error', error: { message, type: 'api_error' } };
  if (protocol === 'responses') {
    output.write(`event: error\ndata: ${JSON.stringify(error)}\n\n`);
    return;
  }
  output.write(`data: ${JSON.stringify({ error: error.error })}\n\n`);
  output.write('data: [DONE]\n\n');
}

function extractOpenAIUsageTokens(value: unknown): number {
  if (!isPlainObject(value)) return 0;
  const total = toInt(value.total_tokens);
  if (total > 0) return total;
  // 有些 OpenAI-compatible 上游不返回 total_tokens，只能从输入/输出字段相加。
  return toInt(value.prompt_tokens) + toInt(value.completion_tokens);
}

function toInt(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) && num > 0 ? Math.trunc(num) : 0;
}
