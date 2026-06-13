/**
 * 三条 Anthropic SSE 管线：
 *   - fixAnthropicSseAndPipe：上游是"半成品 Anthropic SSE"时，逐 chunk 走 StreamingAnthropicSSEFixer 修复
 *   - bufferTransformAndPipeSse：上游是 OpenAI SSE 时，缓冲全量后用一次性转换函数变成 Anthropic SSE
 *   - pipeRawSse：上游格式未知或无需修复，原样 chunk 转发
 *
 * 三者共享：客户端断开优雅退出、idle 超时控制、释放 lease。
 */

import { PassThrough } from 'node:stream';
import { isLogDetailedEnabled, log } from '../../utils/logger.js';
import { readStreamChunk } from '../stream-read.js';
import type { StreamingAnthropicSSEFixer } from '../response-fix.js';
import { markUpstreamResponseStreamError, releaseUpstreamResponse } from '../upstream/response-meta.js';
import { buildLogContext, logStreamStop, type StreamMetrics } from './log-helpers.js';

export async function fixAnthropicSseAndPipe(params: {
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

export async function bufferTransformAndPipeSse(params: {
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

export async function pipeRawSse(params: {
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
