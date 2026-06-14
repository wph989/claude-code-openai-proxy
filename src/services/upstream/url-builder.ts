/**
 * 上游 URL 拼接工具。
 *
 * 分离的原因：
 *   - Anthropic 与 OpenAI 兼容协议的 base_url 处理逻辑不同
 *   - base_url 末尾是否含 `/v1` 需要识别，避免拼出 `/v1/v1`
 */

import type { ResolvedProvider } from '../../types/runtime-config.js';

/**
 * Anthropic 上游 base_url 规范化。
 *
 * Anthropic 供应商通常配置到站点 / API 根路径；Messages API 固定在 /v1 下。
 * 如果用户已经显式写了 /v1，则保持原样，避免重复拼成 /v1/v1。
 */
export function normalizeAnthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/v1$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

export function buildChatCompletionsUrl(provider: ResolvedProvider): string {
  return `${provider.base_url.replace(/\/$/, '')}/chat/completions`;
}

export function buildMessagesUrl(provider: ResolvedProvider): string {
  return `${normalizeAnthropicBaseUrl(provider.base_url)}/messages`;
}

export function buildCountTokensUrl(provider: ResolvedProvider): string {
  return `${normalizeAnthropicBaseUrl(provider.base_url)}/messages/count_tokens`;
}
