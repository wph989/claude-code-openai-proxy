import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { verifyProxyAuth } from '../auth.js';
import { settings } from '../config.js';
import { sendUpstreamErrorResponse, writeStreamHeaders } from '../services/passthrough.js';
import { readStreamChunk } from '../services/stream-read.js';
import { setForwardResponseHeaders } from '../services/http-headers.js';
import { markUpstreamResponseStreamError, releaseUpstreamResponse, safeJson } from '../services/upstream.js';
import { log } from '../utils/logger.js';

export async function registerChatCompletionsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/chat/completions', async (request, reply) => {
    if (!(await verifyProxyAuth(request, reply))) return;
    const payload = (request.body || {}) as Record<string, unknown>;
    const requestId = request.requestId;
    const sessionId = request.sessionId;

    const modelName = String(payload.model || app.runtimeConfigManager.getConfig().default_client_model || '').trim();
    if (!modelName) {
      return reply.code(400).send({
        error: { type: 'invalid_request_error', message: 'model 不能为空，且未配置 default_client_model。' }
      });
    }

    let route, provider, rotator;
    try {
      const resolved = app.runtimeConfigManager.resolveModel(modelName);
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
      client_model: modelName,
      upstream_model: route.upstream_model,
      stream: payload.stream === true,
      request_body: payload
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
      releaseUpstreamResponse(upstreamResponse, { requests: 1, tokens: extractOpenAIUsageTokens(data.usage) });
      if (data.model) data.model = modelName;
      setForwardResponseHeaders(reply, upstreamResponse);
      log('info', 'OpenAI 透传响应完成', {
        provider_id: provider.provider_id,
        client_model: modelName,
        upstream_model: route.upstream_model,
        upstream_status: upstreamResponse.status,
        downstream_status: upstreamResponse.status,
        stream: false,
        response_kind: 'openai-json',
        input_tokens: isPlainObject(data.usage) ? toInt(data.usage.prompt_tokens) : 0,
        output_tokens: isPlainObject(data.usage) ? toInt(data.usage.completion_tokens) : 0,
        total_tokens: isPlainObject(data.usage) ? toInt(data.usage.total_tokens) : 0,
        response_body: data
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

    let clientClosed = false;
    const clientAbort = new AbortController();
    const onClientClose = () => {
      clientClosed = true;
      clientAbort.abort();
      output.destroy();
    };
    reply.raw.once('close', onClientClose);

    const idleTimeoutMs = Math.max(1000, provider.stream_idle_timeout_seconds * 1000 || settings.streamIdleTimeoutMs);
    void pipeOpenAISse({
      upstreamResponse,
      output,
      requestId,
      sessionId,
      providerId: provider.provider_id,
      clientModel: modelName,
      upstreamModel: route.upstream_model,
      idleTimeoutMs,
      isClientClosed: () => clientClosed,
      clientAbortSignal: clientAbort.signal
    }).finally(() => {
      reply.raw.off('close', onClientClose);
    });
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
}): Promise<void> {
  const { upstreamResponse, output, requestId, sessionId, providerId, clientModel, upstreamModel, idleTimeoutMs, isClientClosed, clientAbortSignal } = params;
  try {
    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      output.write(`data: ${JSON.stringify({ error: { message: errorText || `上游请求失败，状态码=${upstreamResponse.status}`, type: 'api_error' } })}\n\n`);
      output.write('data: [DONE]\n\n');
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
        output.write(value);
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    log('info', 'OpenAI 流式透传完成', {
      provider_id: providerId,
      client_model: clientModel,
      upstream_model: upstreamModel,
      request_id: requestId,
      session_id: sessionId,
      upstream_status: upstreamResponse.status,
      downstream_status: upstreamResponse.status,
      stream: true,
      sse_kind: 'openai-sse-raw'
    });
  } catch (error) {
    const clientClosed = isClientClosed?.() === true;
    if (!clientClosed) {
      const message = error instanceof Error ? error.message : String(error);
      markUpstreamResponseStreamError(upstreamResponse, message, 'network');
    }
    if (clientClosed) {
      log('info', '客户端断开，停止 OpenAI 流式透传', {
        provider_id: providerId,
        client_model: clientModel,
        upstream_model: upstreamModel
      });
      return;
    }
    log('error', 'OpenAI 流式透传失败', { error });
    output.write(`data: ${JSON.stringify({ error: { message: '流式透传失败。', type: 'api_error' } })}\n\n`);
    output.write('data: [DONE]\n\n');
  } finally {
    releaseUpstreamResponse(upstreamResponse);
    output.end();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
