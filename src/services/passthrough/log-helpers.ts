/**
 * 透传日志辅助：日志上下文组装、流停止打点、JSON/文本预览。
 *
 * 单独抽出来是因为这些函数在多条不同的 SSE / JSON 管线里被重复调用，
 * 否则同一份组装逻辑会在 5+ 处复制。
 */

import { log } from '../../utils/logger.js';

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

export function buildLogContext(context: PassthroughLogContext | StreamMetrics): Record<string, unknown> {
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

export function logStreamStop(clientClosed: boolean, kind: string, metrics: StreamMetrics, error: unknown): void {
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

export function parseJsonBodyOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function previewText(text: string, maxChars = 1000): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars)}...(已截断, 原长度=${normalized.length})`
    : normalized;
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
