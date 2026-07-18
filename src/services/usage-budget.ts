import type { KeyQuotaConfig, KeyUsage } from '../types/runtime-config.js';

export interface KeyUsageDelta {
  requests: number;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface QuotaEvaluation {
  blocked: boolean;
  reason: string | null;
  ratio: number;
}

export function addUsageDelta(
  current: KeyUsage,
  delta: KeyUsageDelta,
  quota: KeyQuotaConfig | null,
): KeyUsage {
  const usage = normalizeUsage(current);
  const requests = normalizeCounter(delta.requests);
  const tokens = normalizeCounter(delta.tokens);
  const result: KeyUsage = {
    ...usage,
    requests_used: usage.requests_used + requests,
    tokens_used: usage.tokens_used + tokens,
  };
  if (tracksCost(quota) || hasDetailedUsage(usage)) {
    const inputTokens = delta.inputTokens === undefined
      ? tokens
      : normalizeCounter(delta.inputTokens);
    const outputTokens = delta.outputTokens === undefined
      ? Math.max(0, tokens - inputTokens)
      : normalizeCounter(delta.outputTokens);
    result.input_tokens_used = (usage.input_tokens_used ?? 0) + inputTokens;
    result.output_tokens_used = (usage.output_tokens_used ?? 0) + outputTokens;
    result.cost_usd = roundUsd((usage.cost_usd ?? 0) + calculateCostUsd(quota, inputTokens, outputTokens));
  }
  return result;
}

export function emptyUsage(quota: KeyQuotaConfig | null = null): KeyUsage {
  return tracksCost(quota)
    ? {
        requests_used: 0,
        tokens_used: 0,
        input_tokens_used: 0,
        output_tokens_used: 0,
        cost_usd: 0,
      }
    : { requests_used: 0, tokens_used: 0 };
}

export function normalizeUsage(value: KeyUsage | undefined): KeyUsage {
  const result: KeyUsage = {
    requests_used: normalizeCounter(value?.requests_used),
    tokens_used: normalizeCounter(value?.tokens_used),
  };
  if (hasDetailedUsage(value)) {
    result.input_tokens_used = normalizeCounter(value?.input_tokens_used);
    result.output_tokens_used = normalizeCounter(value?.output_tokens_used);
    result.cost_usd = roundUsd(normalizeMoney(value?.cost_usd));
  }
  return result;
}

export function evaluateUsageQuota(
  usageValue: KeyUsage,
  quota: KeyQuotaConfig | null,
): QuotaEvaluation {
  if (!quota) return { blocked: false, reason: null, ratio: 0 };
  const usage = normalizeUsage(usageValue);
  const threshold = quota.soft_stop_threshold ?? 0.95;
  const requestRatio = ratio(usage.requests_used, quota.max_requests);
  const tokenRatio = ratio(usage.tokens_used, quota.max_tokens);
  const costRatio = ratio(usage.cost_usd ?? 0, quota.max_cost_usd);
  if (quota.max_requests != null && requestRatio >= threshold) {
    return { blocked: true, reason: '本地请求配额接近上限', ratio: Math.max(requestRatio, tokenRatio, costRatio) };
  }
  if (quota.max_tokens != null && tokenRatio >= threshold) {
    return { blocked: true, reason: '本地 token 配额接近上限', ratio: Math.max(requestRatio, tokenRatio, costRatio) };
  }
  if (quota.max_cost_usd != null && costRatio >= threshold) {
    return { blocked: true, reason: '本地费用预算接近上限', ratio: Math.max(requestRatio, tokenRatio, costRatio) };
  }
  return { blocked: false, reason: null, ratio: Math.max(requestRatio, tokenRatio, costRatio) };
}

export function calculateCostUsd(
  quota: KeyQuotaConfig | null,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!quota) return 0;
  const inputRate = normalizeMoney(quota.input_cost_per_million);
  const outputRate = normalizeMoney(quota.output_cost_per_million);
  return roundUsd((normalizeCounter(inputTokens) * inputRate + normalizeCounter(outputTokens) * outputRate) / 1_000_000);
}

export function tracksCost(quota: KeyQuotaConfig | null): boolean {
  return quota?.max_cost_usd != null
    || quota?.input_cost_per_million != null
    || quota?.output_cost_per_million != null;
}

function hasDetailedUsage(value: KeyUsage | undefined): boolean {
  return value?.input_tokens_used !== undefined
    || value?.output_tokens_used !== undefined
    || value?.cost_usd !== undefined;
}

function ratio(used: number, limit: number | null | undefined): number {
  return limit != null && limit > 0 ? used / limit : 0;
}

function normalizeCounter(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function normalizeMoney(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function roundUsd(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000_000) / 1_000_000_000;
}
