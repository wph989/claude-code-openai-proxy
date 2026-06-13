import type { FastifyReply } from 'fastify';
import {
  filterForwardResponseHeaders,
  setForwardResponseHeaders,
} from './http-headers.js';

/**
 * 兼容旧导入：新代码统一使用 http-headers.ts。
 * 保留这个文件是为了避免一次重构把历史测试和调用点全部打散。
 */
export function extractUpstreamHeaders(upstreamResponse: Response): Record<string, string> {
  return filterForwardResponseHeaders(upstreamResponse, { stream: true });
}

export function setUpstreamHeaders(reply: FastifyReply, upstreamResponse: Response): void {
  setForwardResponseHeaders(reply, upstreamResponse);
}
