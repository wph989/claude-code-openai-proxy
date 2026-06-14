/**
 * 上游 4xx/5xx 响应的语义分类。
 *
 * 把错误归类为四档，决定 rotator 与重试控制下一步动作：
 *   - hard_limit    Key 不可恢复（额度耗尽 / Key 无效 / 账号封禁）。需要立即切换并禁用 Key。
 *   - rate_limit    限流；当前 Key 临时不可用，设置冷却时间，可换 Key 继续。
 *   - request_limit 请求本身过长（上下文超限）。换 Key 也无济于事，直接回传客户端。
 *   - transient     其他瞬时错误，可重试。
 *
 * 注：上游不同供应商的错误文案不统一，本模块通过关键词命中表（含中文）来近似分类，
 * 新增供应商可在下方表格中扩充关键词。
 */

export type UpstreamErrorCategory = 'hard_limit' | 'rate_limit' | 'transient' | 'request_limit';

export interface UpstreamErrorClassification {
  category: UpstreamErrorCategory;
  reason: string;
}

// hardLimit 必须最先判：quota / insufficient / 账号封禁 等是真正不可恢复，
// 不能被「token limit」「context length」这类同样含 limit 字样的临时错误抢先。
const HARD_LIMIT_KEYWORDS = [
  'quota',
  'insufficient_quota',
  'insufficient quota',
  'insufficient_user_quota',
  'billing hard limit',
  'usage limit',
  'exceeded your current quota',
  'exceeded your quota',
  'quota exceeded',
  'out of quota',
  'invalid api key',
  'invalid_api_key',
  'unauthorized key',
  'incorrect api key',
  'api key is invalid',
  'account banned',
  'account suspended',
  '限额',
  '配额',
  '额度',
  '余额不足',
  '用量不足',
  '用量已达',
  '账单硬限制',
  '账单限制',
  '封禁',
  '账号封禁',
  '账号停用',
  '账号异常'
];

// 上下文 / 输入过长不是 key 的问题，换 key 只会额外消耗配额并污染健康分。
const TOKEN_LIMIT_KEYWORDS = [
  'token-limit',
  'token limit',
  'context length',
  'maximum context length',
  'max tokens',
  'tokens too long',
  '请求 token',
  '上下文长度',
  '最大上下文',
  '输入过长'
];

const RATE_LIMIT_KEYWORDS = [
  'rate limit',
  'rate_limit',
  'ratelimit',
  'too many requests',
  '限流',
  '请求过多',
  '频率限制'
];

export function classifyUpstreamError(status: number, statusText: string, bodyText: string): UpstreamErrorClassification {
  const normalized = bodyText.toLowerCase();

  if (HARD_LIMIT_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return { category: 'hard_limit', reason: 'hard limit or invalid key' };
  }

  if (TOKEN_LIMIT_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return { category: 'request_limit', reason: 'request token or context limit' };
  }

  // 429 状态码优先判定为 rate_limit（触发冷却机制）
  // 即使 body 没有明确的关键词，也应该尊重 HTTP 语义
  if (status === 429) {
    return { category: 'rate_limit', reason: 'HTTP 429 rate limit' };
  }

  if (RATE_LIMIT_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return { category: 'rate_limit', reason: 'temporary rate limit' };
  }
  if (status === 401 || status === 403) {
    return { category: 'hard_limit', reason: statusText || 'unauthorized' };
  }
  return { category: 'transient', reason: statusText || 'transient upstream error' };
}

/**
 * 便捷判断：纯靠 body 文案判定是否为额度类错误。
 * 配额守护（QuotaGuard）等场景用来识别上游传回的"配额耗尽"信号。
 */
export function isQuotaLimitError(text: string): boolean {
  return classifyUpstreamError(400, '', text).category === 'hard_limit';
}
