import type { FastifyReply } from 'fastify';
import { settings } from '../config.js';
import type { ResolvedProvider } from '../models.js';

export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

const REQUEST_SKIP_HEADERS = new Set([
  'host',
  'content-length',
]);

const RESPONSE_SKIP_HEADERS = new Set([
  'content-length',
  'content-encoding',
]);

export interface BuildForwardRequestHeadersParams {
  provider: ResolvedProvider;
  apiKey?: string;
  requestId: string;
  sessionId: string;
  incomingHeaders?: Record<string, string | string[] | undefined>;
  anthropicVersion?: string;
  anthropicBeta?: string;
  forceIdentityAcceptEncoding?: boolean;
}

/**
 * 构造发往上游的请求头。
 *
 * 这里采用黑名单剥离而不是白名单复制，是因为 Claude Code/Anthropic SDK
 * 会依赖一些供应商私有头；只删除跨 hop 不安全或由 fetch 自动计算的头。
 */
export function buildForwardRequestHeaders(params: BuildForwardRequestHeadersParams): Headers {
  const headers = new Headers();

  if (params.incomingHeaders) {
    for (const [key, value] of Object.entries(params.incomingHeaders)) {
      if (value == null) continue;
      const lower = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower) || REQUEST_SKIP_HEADERS.has(lower)) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
  }

  // 代理生成的兜底头不能覆盖客户端明确传入的协议头，避免破坏真实透传语义。
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!headers.has('x-request-id')) headers.set('x-request-id', params.requestId);
  if (!headers.has('x-claude-code-session-id')) headers.set('x-claude-code-session-id', params.sessionId);

  for (const [key, value] of Object.entries(params.provider.headers || {})) {
    if (!headers.has(key)) headers.set(key, value);
  }

  if (params.anthropicVersion) headers.set('anthropic-version', params.anthropicVersion);
  if (params.anthropicBeta) headers.set('anthropic-beta', params.anthropicBeta);

  const shouldForceIdentity = params.forceIdentityAcceptEncoding ?? settings.forceIdentityAcceptEncoding;
  if (shouldForceIdentity) {
    // Node/undici 会自动解压响应体；强制 identity 可避开部分上游错误保留压缩头的问题。
    headers.set('accept-encoding', 'identity');
  }

  if (params.apiKey) {
    if (params.provider.provider_type === 'anthropic') {
      headers.set('x-api-key', params.apiKey);
      headers.delete('authorization');
    } else {
      headers.set('authorization', `Bearer ${params.apiKey}`);
      headers.delete('x-api-key');
    }
  }

  return headers;
}

export interface FilterForwardResponseHeadersOptions {
  stream?: boolean;
}

/**
 * 过滤上游响应头后转发给客户端。
 *
 * content-encoding 必须删除：fetch 返回给应用层的 body 已是解码后的字节，
 * 如果继续转发压缩头，客户端会尝试二次解压。
 */
export function filterForwardResponseHeaders(
  upstreamResponse: Response,
  options: FilterForwardResponseHeadersOptions = {}
): Record<string, string> {
  const headers: Record<string, string> = {};

  upstreamResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (RESPONSE_SKIP_HEADERS.has(lower)) return;
    headers[key] = value;
  });

  if (options.stream) {
    headers['content-type'] = headers['content-type'] || 'text/event-stream; charset=utf-8';
    headers['cache-control'] = headers['cache-control'] || 'no-cache, no-transform';
    headers.connection = 'keep-alive';
  }

  return headers;
}

export function setForwardResponseHeaders(reply: FastifyReply, upstreamResponse: Response): void {
  const headers = filterForwardResponseHeaders(upstreamResponse);
  for (const [key, value] of Object.entries(headers)) {
    reply.header(key, value);
  }
}
