/**
 * 透传日志辅助：组装不含请求标识、模型名和正文的低基数上下文。
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
    provider_id: maybeContext.providerId ?? maybeMetrics.providerId,
    endpoint: maybeContext.endpoint,
  });
}

export function logStreamStop(clientClosed: boolean, kind: string, metrics: StreamMetrics, error: unknown): void {
  if (clientClosed) {
    log('info', '客户端断开，停止流式响应', {
      kind,
      provider_id: metrics.providerId,
    });
    return;
  }
  log('error', `${kind} 失败`, {
    provider_id: metrics.providerId,
    error,
  });
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  let hasUndefined = false;
  for (const key in value) {
    if (value[key] === undefined) { hasUndefined = true; break; }
  }
  if (!hasUndefined) return value;
  const result: Record<string, unknown> = {};
  for (const key in value) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}
