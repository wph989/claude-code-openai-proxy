/**
 * 上游为 Anthropic 类型时的请求 payload 构造。
 *
 * 关键点：非流式请求要把所有嵌套的 stream_options 字段清掉。Claude Code 或兼容 SDK
 * 在某些组合下会把 OpenAI 的 stream_options 透传到 metadata 等深层字段；Anthropic
 * 原生接口不认识这个字段，遇到就会返回 400。
 */

import type { AnthropicMessagesRequest, ResolvedRoute } from '../../types/runtime-config.js';

export function buildAnthropicPassthroughPayload(
  payload: AnthropicMessagesRequest,
  route: Pick<ResolvedRoute, 'upstream_model' | 'extra_body'>
): Record<string, unknown> {
  const merged = {
    ...(payload as unknown as Record<string, unknown>),
    model: route.upstream_model,
    ...route.extra_body,
  };

  return payload.stream === true ? merged : removeNestedStreamOptions(merged);
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
