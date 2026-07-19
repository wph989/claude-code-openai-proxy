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
import type { ProviderCircuitLease, ProviderHealthRegistry } from '../provider-health.js';

interface ResponseMeta {
  rotator?: ApiKeyRotator;
  key?: string;
  lease?: KeyLease;
  providerHealth?: ProviderHealthRegistry;
  providerId?: string;
  providerCircuitLease?: ProviderCircuitLease;
  keyOutcomeRecorded?: boolean;
  providerOutcomeRecorded?: boolean;
}

const responseMeta = new WeakMap<Response, ResponseMeta>();

export function attachResponseMeta(response: Response, meta: ResponseMeta): void {
  responseMeta.set(response, meta);
}

/**
 * 非流式响应拿到 HTTP 头后先释放并发 lease，但保留 Response 元数据，
 * 让路由层读完正文后仍能记录用量或把协议异常记到原 Key。
 */
export function releaseUpstreamResponseLease(response: Response): void {
  const meta = responseMeta.get(response);
  if (!meta?.lease || !meta.rotator) return;
  meta.rotator.release(meta.lease);
  meta.lease = undefined;
}

/**
 * 标记响应已处理完毕：归还 lease、记录用量。
 * 调用应是幂等的：路由层和 SSE 修复器都可能在不同时机触发 release。
 */
export function releaseUpstreamResponse(response: Response, usage?: {
  requests: number;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
}): void {
  const meta = responseMeta.get(response);
  if (!meta) return;
  if (usage && meta.rotator && meta.key) {
    meta.rotator.recordUsage(meta.key, usage.requests, usage.tokens, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });
  }
  if (meta.rotator && meta.key && !meta.keyOutcomeRecorded) {
    // 只有正文和协议处理都完成后才算成功，避免 2xx 空响应先清零历史错误。
    meta.rotator.markSuccess(meta.key);
    meta.keyOutcomeRecorded = true;
  }
  if (meta.lease && meta.rotator) meta.rotator.release(meta.lease);
  if (meta.providerHealth && meta.providerId && !meta.providerOutcomeRecorded) {
    meta.providerHealth.recordSuccess(meta.providerId, meta.providerCircuitLease);
  }
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
  if (meta.rotator && meta.key && !meta.keyOutcomeRecorded) {
    meta.rotator.markError(meta.key, message, category);
    meta.keyOutcomeRecorded = true;
  }
  if (meta.providerHealth && meta.providerId && !meta.providerOutcomeRecorded) {
    // 流式阶段已经拿到 HTTP 头；此处的断流只能归为链路故障，不能把它算成单 Key 配额错误。
    meta.providerHealth.recordFailure(meta.providerId, 'network', meta.providerCircuitLease);
    meta.providerOutcomeRecorded = true;
  }
}

/**
 * 记录 HTTP 成功但协议内容无效的响应。
 *
 * 上游已经返回 2xx 时，重试层无法再根据状态码识别故障；路由层发现空响应
 * 后必须通过 Response 元数据把问题归还给实际使用的 Key，否则它会被误记为成功。
 */
export function markUpstreamResponseError(
  response: Response,
  message: string,
  category: KeyErrorCategory = 'transient'
): void {
  const meta = responseMeta.get(response);
  if (!meta) return;
  if (meta.rotator && meta.key && !meta.keyOutcomeRecorded) {
    meta.rotator.markError(meta.key, message, category);
    meta.keyOutcomeRecorded = true;
  }
  if (meta.providerHealth && meta.providerId && !meta.providerOutcomeRecorded) {
    meta.providerHealth.recordFailure(meta.providerId, 'server', meta.providerCircuitLease);
    meta.providerOutcomeRecorded = true;
  }
}

/** 非流式 body 已完整读完时先确认 Provider 成功，后续协议转换异常不应占住半开探测。 */
export function markUpstreamResponseBodyComplete(response: Response): void {
  const meta = responseMeta.get(response);
  if (!meta?.providerHealth || !meta.providerId || meta.providerOutcomeRecorded) return;
  meta.providerHealth.recordSuccess(meta.providerId, meta.providerCircuitLease);
  meta.providerOutcomeRecorded = true;
}
