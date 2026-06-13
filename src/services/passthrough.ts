/**
 * Anthropic Messages 路由的响应透传入口。
 *
 * 把"上游响应 → Anthropic 兼容响应"的整体编排放在这里，具体实现拆到 ./passthrough/*：
 *   - peek-restore        peek 头部用于识别 SSE 类型
 *   - anthropic-shape     JSON 兜底字段补齐
 *   - anthropic-payload   非流式 payload 清理（去 stream_options）
 *   - sse-pipelines       三条 SSE 管线（修复 / 转换 / 原样）
 *   - log-helpers         统一日志上下文
 */

import { PassThrough } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { log } from '../utils/logger.js';
import {
  StreamingAnthropicSSEFixer,
  looksLikeAnthropicSSE,
  looksLikeOpenAISSE,
  transformOpenAIJsonToAnthropicJson,
  transformOpenAISSEToAnthropicSSE,
} from './response-fix.js';
import { filterForwardResponseHeaders, setForwardResponseHeaders } from './http-headers.js';
import { releaseUpstreamResponse, markUpstreamResponseStreamError } from './upstream/response-meta.js';
import { peekAndRestore } from './passthrough/peek-restore.js';
import {
  ensureAnthropicJsonShape,
  extractAnthropicUsageTokens,
  isPlainObject,
  toNonNegInt,
} from './passthrough/anthropic-shape.js';
import {
  bufferTransformAndPipeSse,
  fixAnthropicSseAndPipe,
  pipeRawSse,
} from './passthrough/sse-pipelines.js';
import {
  buildLogContext,
  parseJsonBodyOrText,
  previewText,
  type PassthroughLogContext,
  type StreamMetrics,
} from './passthrough/log-helpers.js';

export { buildAnthropicPassthroughPayload } from './passthrough/anthropic-payload.js';
export type { PassthroughLogContext, StreamMetrics };

export async function sendUpstreamErrorResponse(
  reply: FastifyReply,
  upstreamResponse: Response,
  context: PassthroughLogContext = {}
): Promise<unknown> {
  const bodyText = await upstreamResponse.text();
  setForwardResponseHeaders(reply, upstreamResponse);
  releaseUpstreamResponse(upstreamResponse);

  const contentType = upstreamResponse.headers.get('content-type')?.toLowerCase() || '';
  log('warn', '上游错误响应已透传', {
    ...buildLogContext(context),
    upstream_status: upstreamResponse.status,
    downstream_status: upstreamResponse.status,
    stream: context.stream === true,
    content_type: contentType || null,
    error_preview: previewText(bodyText),
    response_body: parseJsonBodyOrText(bodyText),
  });

  if (contentType.includes('application/json')) {
    try {
      return reply.code(upstreamResponse.status).send(JSON.parse(bodyText));
    } catch {
      return reply.code(upstreamResponse.status).send({ raw: bodyText });
    }
  }

  return reply.code(upstreamResponse.status).send(bodyText);
}

export async function sendAnthropicPassthroughResponse(params: {
  reply: FastifyReply;
  upstreamResponse: Response;
  fallbackModel: string;
  context?: PassthroughLogContext;
}): Promise<unknown> {
  const { reply, upstreamResponse, fallbackModel, context = {} } = params;
  if (!upstreamResponse.ok) {
    return sendUpstreamErrorResponse(reply, upstreamResponse, { ...context, stream: false });
  }

  const contentType = upstreamResponse.headers.get('content-type')?.toLowerCase() || '';
  const bodyText = await upstreamResponse.text();
  if (!contentType.includes('application/json')) {
    releaseUpstreamResponse(upstreamResponse);
    log('warn', 'Anthropic 透传响应异常', {
      ...buildLogContext(context),
      upstream_status: upstreamResponse.status,
      downstream_status: 502,
      stream: false,
      response_kind: 'non-json',
      content_type: contentType || null,
      response_preview: previewText(bodyText),
      response_body: bodyText,
    });
    return reply.code(502).send({
      type: 'error',
      error: {
        type: 'proxy_error',
        message: '上游返回的不是 JSON API 响应，请检查 provider.base_url 和模型路由配置。',
      },
    });
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    releaseUpstreamResponse(upstreamResponse);
    log('warn', 'Anthropic 透传响应异常', {
      ...buildLogContext(context),
      upstream_status: upstreamResponse.status,
      downstream_status: 502,
      stream: false,
      response_kind: 'invalid-json',
      content_type: contentType || null,
      response_preview: previewText(bodyText),
      response_body: bodyText,
    });
    return reply.code(502).send({
      type: 'error',
      error: {
        type: 'proxy_error',
        message: '上游返回了无法解析的 JSON 响应。',
      },
    });
  }

  const responseKind = isOpenAIChatCompletionJson(data) ? 'openai-json-converted' : 'anthropic-json';
  const output = isOpenAIChatCompletionJson(data)
    ? ensureAnthropicJsonShape(
      JSON.parse(transformOpenAIJsonToAnthropicJson(Buffer.from(bodyText, 'utf8')).toString('utf8')) as Record<string, unknown>,
      fallbackModel
    )
    : ensureAnthropicJsonShape(data, fallbackModel);

  releaseUpstreamResponse(upstreamResponse, {
    requests: 1,
    tokens: extractAnthropicUsageTokens(output.usage),
  });
  setForwardResponseHeaders(reply, upstreamResponse);
  log('info', 'Anthropic 透传响应完成', {
    ...buildLogContext(context),
    upstream_status: upstreamResponse.status,
    downstream_status: upstreamResponse.status,
    stream: false,
    response_kind: responseKind,
    response_id: output.id,
    stop_reason: output.stop_reason ?? null,
    input_tokens: isPlainObject(output.usage) ? toNonNegInt(output.usage.input_tokens) : 0,
    output_tokens: isPlainObject(output.usage) ? toNonNegInt(output.usage.output_tokens) : 0,
    content_blocks: Array.isArray(output.content) ? output.content.length : 0,
    response_body: output,
  });
  return reply.code(upstreamResponse.status).send(output);
}

/**
 * 编排 Anthropic SSE 修复管线：先 peek 16KB 识别协议形态，再分发到三条管线之一。
 */
export async function pipeAnthropicSseWithRepair(params: {
  upstreamResponse: Response;
  output: PassThrough;
  metrics: StreamMetrics;
  idleTimeoutMs: number;
  isClientClosed?: () => boolean;
  clientAbortSignal?: AbortSignal;
}): Promise<void> {
  const { upstreamResponse, output, metrics, idleTimeoutMs, isClientClosed, clientAbortSignal } = params;
  const { peek, restored, peekError } = await peekAndRestore(upstreamResponse, 16384, idleTimeoutMs, clientAbortSignal);
  // peek 会创建新的 Response，lease 元数据仍挂在原始 Response 上；释放/记错必须用原始对象。
  const releaseResponse = upstreamResponse;
  if (peekError && clientAbortSignal?.aborted !== true) {
    markUpstreamResponseStreamError(releaseResponse, peekError, 'network');
  }

  if (peek.length > 0 && looksLikeOpenAISSE(peek)) {
    await bufferTransformAndPipeSse({
      upstreamResponse: restored,
      releaseResponse,
      output,
      transform: transformOpenAISSEToAnthropicSSE,
      kind: 'OpenAI-SSE→Anthropic-SSE',
      metrics,
      isClientClosed,
    });
    return;
  }

  if (peek.length > 0 && looksLikeAnthropicSSE(peek)) {
    await fixAnthropicSseAndPipe({
      upstreamResponse: restored,
      releaseResponse,
      upstreamReadError: peekError,
      output,
      fixer: new StreamingAnthropicSSEFixer({ dropThinking: true }),
      metrics,
      idleTimeoutMs,
      isClientClosed,
      clientAbortSignal,
    });
    return;
  }

  await pipeRawSse({
    upstreamResponse: restored,
    releaseResponse,
    output,
    metrics,
    idleTimeoutMs,
    isClientClosed,
    clientAbortSignal,
  });
}

export function writeStreamHeaders(reply: FastifyReply, upstreamResponse: Response): void {
  reply.hijack();
  reply.raw.writeHead(upstreamResponse.status, filterForwardResponseHeaders(upstreamResponse, { stream: true }));
}

function isOpenAIChatCompletionJson(data: Record<string, unknown>): boolean {
  return typeof data.object === 'string' && data.object.startsWith('chat.completion');
}
