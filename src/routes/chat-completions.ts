import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { verifyProxyAuth } from '../auth.js';
import { settings } from '../config.js';
import { releaseUpstreamResponse, safeJson } from '../services/upstream.js';
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
      const data = await safeJson(upstreamResponse);
      if (!upstreamResponse.ok) {
        return reply.code(upstreamResponse.status).send(data);
      }
      releaseUpstreamResponse(upstreamResponse, { requests: 1, tokens: extractOpenAIUsageTokens(data.usage) });
      if (data.model) data.model = modelName;
      log('info', 'OpenAI 透传响应完成', {
        provider_id: provider.provider_id,
        client_model: modelName,
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
    void pipeOpenAISse({ upstreamResponse, output, requestId, sessionId, providerId: provider.provider_id, clientModel: modelName, upstreamModel: route.upstream_model, idleTimeoutMs });
  });
}

async function pipeOpenAISse(params: {
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

    log('info', 'OpenAI 流式透传完成', {
      provider_id: providerId,
      client_model: clientModel,
      upstream_model: upstreamModel
    });
  } catch (error) {
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
