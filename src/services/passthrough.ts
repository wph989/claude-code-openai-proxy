import { PassThrough } from 'node:stream';
import type { FastifyReply } from 'fastify';
import type { AnthropicMessagesRequest, ResolvedRoute } from '../models.js';
import { createId } from '../utils/id.js';
import { isLogDetailedEnabled, log } from '../utils/logger.js';
import { readStreamChunk } from './stream-read.js';
import {
  StreamingAnthropicSSEFixer,
  looksLikeAnthropicSSE,
  looksLikeOpenAISSE,
  transformOpenAIJsonToAnthropicJson,
  transformOpenAISSEToAnthropicSSE,
} from './response-fix.js';
import { filterForwardResponseHeaders, setForwardResponseHeaders } from './http-headers.js';
import { markUpstreamResponseStreamError, releaseUpstreamResponse } from './upstream.js';

export interface StreamMetrics {
  requestId: string;
  sessionId: string;
  providerId: string;
  clientModel: string;
  upstreamModel: string;
  endpoint?: string;
}

export interface PassthroughLogContext {
  requestId?: string;
  sessionId?: string;
  providerId?: string;
  clientModel?: string;
  upstreamModel?: string;
  stream?: boolean;
  endpoint?: string;
}

export function buildAnthropicPassthroughPayload(
  payload: AnthropicMessagesRequest,
  route: Pick<ResolvedRoute, 'upstream_model' | 'extra_body'>
): Record<string, unknown> {
  const merged = {
    ...(payload as unknown as Record<string, unknown>),
    model: route.upstream_model,
    ...route.extra_body,
  };

  // Anthropic 原生接口不认识 OpenAI 的 stream_options。非流式时递归清理，
  // 避免 Claude Code 或兼容 SDK 把额外配置塞进 metadata 后导致上游 400。
  return payload.stream === true ? merged : removeNestedStreamOptions(merged);
}

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

function removeNestedStreamOptions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  if (Array.isArray(value)) {
    return value.map((item) => removeNestedValue(item)) as unknown as Record<string, unknown>;
  }
  return removeNestedValue(value) as Record<string, unknown>;
}

function removeNestedValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => removeNestedValue(item));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'stream_options') continue;
    output[key] = removeNestedValue(item);
  }
  return output;
}

function isOpenAIChatCompletionJson(data: Record<string, unknown>): boolean {
  return typeof data.object === 'string' && data.object.startsWith('chat.completion');
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

async function peekAndRestore(
  response: Response,
  bytes: number,
  idleTimeoutMs: number,
  abortSignal?: AbortSignal
): Promise<{ peek: Buffer; restored: Response; peekError?: string }> {
  if (!response.body) return { peek: Buffer.alloc(0), restored: response };
  const reader = response.body.getReader();
  const head: Uint8Array[] = [];
  let total = 0;
  let peekError: string | undefined;

  try {
    while (total < bytes) {
      const { value, done } = await readStreamChunk(reader, idleTimeoutMs, `SSE peek timeout after ${idleTimeoutMs}ms`, abortSignal);
      if (done) break;
      head.push(value);
      total += value.length;
      if (total >= bytes) break;
    }
  } catch (error) {
    peekError = error instanceof Error ? error.message : String(error);
    // peek 失败时保留已读片段，后续管道会负责释放 lease 和结束响应。
  }

  const peek = Buffer.concat(head.map((chunk) => Buffer.from(chunk)));
  if (peek.length === 0) return { peek, restored: response, peekError };

  const combined = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const chunk of head) controller.enqueue(chunk);
        if (peekError) {
          // 上游在 peek 阶段已经断流时，仍要把已读到的 Anthropic 头部交给修复器，
          // 让它补齐 message_stop；否则客户端只能看到一个代理 error 事件。
          controller.close();
          return;
        }
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return {
    peek,
    peekError,
    restored: new Response(combined, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

async function fixAnthropicSseAndPipe(params: {
  upstreamResponse: Response;
  releaseResponse?: Response;
  upstreamReadError?: string;
  output: PassThrough;
  fixer: StreamingAnthropicSSEFixer;
  metrics: StreamMetrics;
  idleTimeoutMs: number;
  isClientClosed?: () => boolean;
  clientAbortSignal?: AbortSignal;
}): Promise<void> {
  const { upstreamResponse, releaseResponse = upstreamResponse, upstreamReadError, output, fixer, metrics, idleTimeoutMs, isClientClosed, clientAbortSignal } = params;
  const captureResponseBody = isLogDetailedEnabled();
  const responseChunks: Buffer[] = [];
  try {
    const body = upstreamResponse.body;
    if (!body) return;
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await readStreamChunk(reader, idleTimeoutMs, `SSE idle timeout: ${idleTimeoutMs}ms`, clientAbortSignal);
        if (done) break;
        if (isClientClosed?.()) return;
        const fixed = fixer.push(value);
        if (fixed) {
          if (captureResponseBody) responseChunks.push(fixed);
          output.write(fixed);
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    if (isClientClosed?.()) return;
    const tail = fixer.finalize();
    if (tail.length > 0) {
      if (captureResponseBody) responseChunks.push(tail);
      output.write(tail);
    }
    releaseUpstreamResponse(releaseResponse);
    const logLevel = upstreamReadError ? 'warn' : 'info';
    log(logLevel, upstreamReadError ? 'Anthropic SSE 修复遇到上游流异常，已补齐收尾' : 'Anthropic 流式透传响应完成', {
      ...buildLogContext(metrics),
      upstream_status: upstreamResponse.status,
      downstream_status: upstreamResponse.status,
      stream: true,
      sse_kind: upstreamReadError ? 'anthropic-sse-repaired-partial' : 'anthropic-sse-repaired',
      ...(upstreamReadError ? { error_message: upstreamReadError } : {}),
      fix_info: fixer.getFixInfo(),
      response_body: captureResponseBody ? Buffer.concat(responseChunks).toString('utf8') : undefined,
    });
  } catch (error) {
    const clientClosed = isClientClosed?.() === true;
    let recoveredPartial = false;
    if (!clientClosed) {
      markUpstreamResponseStreamError(releaseResponse, error instanceof Error ? error.message : String(error), 'network');
      const tail = fixer.finalize();
      if (tail.length > 0 && fixer.hasMessageStart()) {
        recoveredPartial = true;
        // 已经开始 Anthropic message 时，优先补齐合法收尾；额外 error 事件会让 Claude Code
        // 在半截消息后继续报协议错误，反而掩盖上游断流的根因。
        if (captureResponseBody) responseChunks.push(tail);
        output.write(tail);
        log('warn', 'Anthropic SSE 修复遇到上游流异常，已补齐收尾', {
          ...buildLogContext(metrics),
          upstream_status: upstreamResponse.status,
          downstream_status: upstreamResponse.status,
          stream: true,
          sse_kind: 'anthropic-sse-repaired-partial',
          error_message: error instanceof Error ? error.message : String(error),
          fix_info: fixer.getFixInfo(),
          response_body: captureResponseBody ? Buffer.concat(responseChunks).toString('utf8') : undefined,
        });
      } else {
        output.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: '流式修复失败。' } })}\n\n`);
      }
    }
    if (!recoveredPartial) {
      logStreamStop(clientClosed, 'Anthropic SSE 修复', metrics, error);
    }
  } finally {
    releaseUpstreamResponse(releaseResponse);
    output.end();
  }
}

async function bufferTransformAndPipeSse(params: {
  upstreamResponse: Response;
  releaseResponse?: Response;
  output: PassThrough;
  transform: (body: Buffer) => Buffer;
  kind: string;
  metrics: StreamMetrics;
  isClientClosed?: () => boolean;
}): Promise<void> {
  const { upstreamResponse, releaseResponse = upstreamResponse, output, transform, kind, metrics, isClientClosed } = params;
  try {
    const body = upstreamResponse.body;
    if (!body) return;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    if (isClientClosed?.()) return;
    const fixed = transform(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    output.write(fixed);
    releaseUpstreamResponse(releaseResponse);
    log('info', 'Anthropic 流式透传响应完成', {
      ...buildLogContext(metrics),
      upstream_status: upstreamResponse.status,
      downstream_status: upstreamResponse.status,
      stream: true,
      sse_kind: 'openai-sse-converted',
      transform_kind: kind,
      response_bytes: fixed.length,
      response_body: fixed.toString('utf8'),
    });
  } catch (error) {
    const clientClosed = isClientClosed?.() === true;
    if (!clientClosed) {
      markUpstreamResponseStreamError(releaseResponse, error instanceof Error ? error.message : String(error), 'network');
      output.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: '流式转换失败。' } })}\n\n`);
    }
    logStreamStop(clientClosed, kind, metrics, error);
  } finally {
    releaseUpstreamResponse(releaseResponse);
    output.end();
  }
}

async function pipeRawSse(params: {
  upstreamResponse: Response;
  releaseResponse?: Response;
  output: PassThrough;
  metrics: StreamMetrics;
  idleTimeoutMs: number;
  isClientClosed?: () => boolean;
  clientAbortSignal?: AbortSignal;
}): Promise<void> {
  const { upstreamResponse, releaseResponse = upstreamResponse, output, metrics, idleTimeoutMs, isClientClosed, clientAbortSignal } = params;
  try {
    const body = upstreamResponse.body;
    if (!body) return;
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await readStreamChunk(reader, idleTimeoutMs, `SSE idle timeout: ${idleTimeoutMs}ms`, clientAbortSignal);
        if (done) break;
        if (value) output.write(value);
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    releaseUpstreamResponse(releaseResponse);
    log('info', 'Anthropic 流式透传响应完成', {
      ...buildLogContext(metrics),
      upstream_status: upstreamResponse.status,
      downstream_status: upstreamResponse.status,
      stream: true,
      sse_kind: 'raw-sse',
    });
  } catch (error) {
    const clientClosed = isClientClosed?.() === true;
    if (!clientClosed) {
      markUpstreamResponseStreamError(releaseResponse, error instanceof Error ? error.message : String(error), 'network');
      output.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: '流式透传失败。' } })}\n\n`);
    }
    logStreamStop(clientClosed, 'Anthropic SSE 透传', metrics, error);
  } finally {
    releaseUpstreamResponse(releaseResponse);
    output.end();
  }
}

function logStreamStop(clientClosed: boolean, kind: string, metrics: StreamMetrics, error: unknown): void {
  if (clientClosed) {
    log('info', '客户端断开，停止流式响应', {
      kind,
      provider_id: metrics.providerId,
      client_model: metrics.clientModel,
      upstream_model: metrics.upstreamModel,
    });
    return;
  }
  log('error', `${kind} 失败`, {
    provider_id: metrics.providerId,
    client_model: metrics.clientModel,
    upstream_model: metrics.upstreamModel,
    error,
  });
}

function extractAnthropicUsageTokens(value: unknown): number {
  if (!isPlainObject(value)) return 0;
  return toNonNegInt(value.input_tokens) + toNonNegInt(value.output_tokens);
}

function buildLogContext(context: PassthroughLogContext | StreamMetrics): Record<string, unknown> {
  const maybeMetrics = context as Partial<StreamMetrics>;
  const maybeContext = context as PassthroughLogContext;
  return omitUndefined({
    request_id: maybeContext.requestId ?? maybeMetrics.requestId,
    session_id: maybeContext.sessionId ?? maybeMetrics.sessionId,
    provider_id: maybeContext.providerId ?? maybeMetrics.providerId,
    client_model: maybeContext.clientModel ?? maybeMetrics.clientModel,
    upstream_model: maybeContext.upstreamModel ?? maybeMetrics.upstreamModel,
    endpoint: maybeContext.endpoint,
  });
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function parseJsonBodyOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function previewText(text: string, maxChars = 1000): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars)}...(已截断, 原长度=${normalized.length})`
    : normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toNonNegInt(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : 0;
}
