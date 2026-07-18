/**
 * 把"已发出的 Response 关联到对应的 Key lease / 用量回调"。
 *
 * 这里用 WeakMap 而不是直接在 Response 上挂属性，是因为：
 *   - Response 由 fetch 返回，不能扩展自定义属性
 *   - WeakMap 在 Response 被回收后自动清空，避免内存泄漏
 *
 * 路由层 / passthrough / stream-bridge 在响应结束或流中断时调用 release / mark*，
 * 由此把 Key 的健康度和用量统计同步回 rotator。
 */

import type { ApiKeyRotator, KeyErrorCategory, KeyLease } from '../api-key-rotator.js';
import type { ProviderHealthRegistry } from '../provider-health.js';

interface ResponseMeta {
  rotator?: ApiKeyRotator;
  key?: string;
  lease?: KeyLease;
  providerHealth?: ProviderHealthRegistry;
  providerId?: string;
}

const responseMeta = new WeakMap<Response, ResponseMeta>();

export function attachResponseMeta(response: Response, meta: ResponseMeta): void {
  responseMeta.set(response, meta);
}

/**
 * 标记响应已处理完毕：归还 lease、记录用量。
 * 调用应是幂等的：路由层和 SSE 修复器都可能在不同时机触发 release。
 */
export function releaseUpstreamResponse(response: Response, usage?: { requests: number; tokens: number }): void {
  const meta = responseMeta.get(response);
  if (!meta) return;
  if (usage && meta.rotator && meta.key) meta.rotator.recordUsage(meta.key, usage.requests, usage.tokens);
  if (meta.lease && meta.rotator) meta.rotator.release(meta.lease);
  responseMeta.delete(response);
}

/**
 * 流式响应中途出错时回写 Key 健康状态。
 *
 * 流式 body 阶段的错误发生在 fetch 已成功之后，只能通过 Response 元数据回写 Key 健康状态。
 */
export function markUpstreamResponseStreamError(
  response: Response,
  message: string,
  category: KeyErrorCategory = 'network'
): void {
  const meta = responseMeta.get(response);
  if (!meta) return;
  if (meta.rotator && meta.key) meta.rotator.markError(meta.key, message, category);
  if (meta.providerHealth && meta.providerId) {
    // 流式阶段已经拿到 HTTP 头；此处的断流只能归为链路故障，不能把它算成单 Key 配额错误。
    meta.providerHealth.recordFailure(meta.providerId, 'network');
  }
}
