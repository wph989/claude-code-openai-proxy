/**
 * Anthropic 响应体的兜底字段补齐工具。
 *
 * 上游（含 oneapi 等兼容网关）返回的 Anthropic JSON 经常缺字段或带 OpenAI 风格的 id。
 * Claude Code 客户端对 schema 校验很严，缺字段会直接报错，所以这里在转发前补齐：
 *   - id：chatcmpl-XXX 或为空 → 替换成 msg_<hex>
 *   - type / role / content / stop_* 等基础字段补默认值
 *   - usage 五字段补齐（含 Anthropic 必填的 cache_* 与 server_tool_use）
 *   - output_tokens 至少为 1（Anthropic schema 不接受 0）
 */

import { createId } from '../../utils/id.js';

export function ensureAnthropicJsonShape(data: Record<string, unknown>, fallbackModel: string): Record<string, unknown> {
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

/**
 * Anthropic 原生响应没有 total_tokens 字段，只能用输入/输出相加来驱动本地配额守护。
 */
export function extractAnthropicUsageTokens(value: unknown): number {
  if (!isPlainObject(value)) return 0;
  return toNonNegInt(value.input_tokens) + toNonNegInt(value.output_tokens);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function toNonNegInt(value: unknown): number {
  const num = Number(value ?? 0);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : 0;
}
