import { setGlobalDispatcher, Agent } from 'undici';
import { settings } from '../config.js';
import type { ResolvedProvider, ResolvedRoute } from '../models.js';
import type { ApiKeyRotator, KeyLease } from './api-key-rotator.js';

const responseLeases = new WeakMap<Response, { rotator: ApiKeyRotator; lease: KeyLease }>();

// 设置全局连接池配置
const agent = new Agent({
  keepAliveTimeout: settings.keepAliveTimeout,
  keepAliveMaxTimeout: settings.keepAliveTimeout * 2,
  connections: settings.maxSockets,
  pipelining: 1
});
setGlobalDispatcher(agent);

// 转发时需要剥离的 hop-by-hop 头和 auth 头（auth 由上游 key 替换）
const HEADERS_TO_STRIP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'content-length', 'te', 'trailer', 'upgrade',
  'proxy-authorization', 'proxy-connection',
  'authorization', 'x-api-key',
]);

/**
 * 上游请求服务：
 * - 保留原始请求 headers 和 body，仅替换 auth、model 等必要字段
 * - 支持多 API Key 轮询和 429 自动切换
 */
export class UpstreamService {
  buildChatCompletionsUrl(provider: ResolvedProvider): string {
    return `${provider.base_url.replace(/\/$/, '')}/chat/completions`;
  }

  private buildMessagesUrl(provider: ResolvedProvider): string {
    return `${provider.base_url.replace(/\/$/, '')}/messages`;
  }

  private buildHeadersWithKey(params: {
    provider: ResolvedProvider;
    apiKey?: string;
    requestId: string;
    sessionId: string;
    incomingHeaders?: Record<string, string | string[] | undefined>;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Headers {
    const headers = new Headers();

    if (params.incomingHeaders) {
      for (const [key, value] of Object.entries(params.incomingHeaders)) {
        if (value == null) continue;
        if (HEADERS_TO_STRIP.has(key.toLowerCase())) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
    }

    headers.set('content-type', 'application/json');
    headers.set('x-request-id', params.requestId);
    headers.set('x-claude-code-session-id', params.sessionId);

    if (params.apiKey) {
      if (params.provider.provider_type === 'anthropic') {
        headers.set('x-api-key', params.apiKey);
      } else {
        headers.set('authorization', `Bearer ${params.apiKey}`);
      }
    }

    if (params.anthropicVersion) {
      headers.set('anthropic-version', params.anthropicVersion);
    }
    if (params.anthropicBeta) {
      headers.set('anthropic-beta', params.anthropicBeta);
    }
    for (const [key, value] of Object.entries(params.provider.headers || {})) {
      headers.set(key, value);
    }
    return headers;
  }

  private async doFetch(params: {
    url: string;
    provider: ResolvedProvider;
    rotator?: ApiKeyRotator;
    payload: string;
    timeoutMs?: number;
    requestId: string;
    sessionId: string;
    incomingHeaders?: Record<string, string | string[] | undefined>;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Promise<{ response: Response; lease: KeyLease | undefined }> {
    const lease = params.rotator ? await params.rotator.acquire() : undefined;
    const apiKey = lease?.key;
    const fetchParams: RequestInit = {
      method: 'POST',
      headers: this.buildHeadersWithKey({
        provider: params.provider,
        apiKey,
        requestId: params.requestId,
        sessionId: params.sessionId,
        incomingHeaders: params.incomingHeaders,
        anthropicVersion: params.anthropicVersion,
        anthropicBeta: params.anthropicBeta,
      }),
      body: params.payload,
    };
    if (params.timeoutMs) {
      fetchParams.signal = AbortSignal.timeout(params.timeoutMs);
    }
    try {
      return { response: await fetch(params.url, fetchParams), lease };
    } catch (error) {
      if (params.rotator && lease) {
        params.rotator.markNetworkError(lease.key, error instanceof Error ? error.message : String(error));
        params.rotator.release(lease);
      }
      throw error;
    }
  }

  async postChatCompletions(params: {
    provider: ResolvedProvider;
    route: ResolvedRoute;
    rotator?: ApiKeyRotator;
    payload: Record<string, unknown>;
    requestId: string;
    sessionId: string;
    incomingHeaders?: Record<string, string | string[] | undefined>;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Promise<Response> {
    return this.postToUpstream({
      ...params,
      url: this.buildChatCompletionsUrl(params.provider)
    });
  }

  async postMessages(params: {
    provider: ResolvedProvider;
    route: ResolvedRoute;
    rotator?: ApiKeyRotator;
    payload: Record<string, unknown>;
    requestId: string;
    sessionId: string;
    incomingHeaders?: Record<string, string | string[] | undefined>;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Promise<Response> {
    return this.postToUpstream({
      ...params,
      url: this.buildMessagesUrl(params.provider)
    });
  }

  private async postToUpstream(params: {
    provider: ResolvedProvider;
    route: ResolvedRoute;
    rotator?: ApiKeyRotator;
    payload: Record<string, unknown>;
    url: string;
    requestId: string;
    sessionId: string;
    incomingHeaders?: Record<string, string | string[] | undefined>;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Promise<Response> {
    const body = JSON.stringify(params.payload);

    const timeoutMs = params.payload.stream === true
      ? undefined
      : Math.max(1000, params.provider.timeout_seconds * 1000 || settings.requestTimeoutMs);

    if (params.rotator && !params.rotator.hasAvailableKey()) {
      throw new Error(`供应商 ${params.provider.provider_id} 的所有 API Key 均不可用`);
    }

    const result = await this.doFetch({
      url: params.url,
      provider: params.provider,
      rotator: params.rotator,
      payload: body,
      timeoutMs,
      requestId: params.requestId,
      sessionId: params.sessionId,
      incomingHeaders: params.incomingHeaders,
      anthropicVersion: params.anthropicVersion,
      anthropicBeta: params.anthropicBeta,
    });

    const response = result.response;
    const usedKey = result.lease?.key;

    if (response.ok) {
      if (params.rotator && usedKey) {
        params.rotator.markSuccess(usedKey);
      }
      if (params.rotator && result.lease) {
        if (params.payload.stream === true) {
          responseLeases.set(response, { rotator: params.rotator, lease: result.lease });
        } else {
          params.rotator.release(result.lease);
        }
      }
      return response;
    }

    if (params.rotator && usedKey) {
      const bodyText = await readResponseText(response);
      const errorText = summarizeUpstreamError(response, bodyText);
      const classification = classifyUpstreamError(response.status, response.statusText, bodyText);
      if (classification.category === 'hard_limit') {
        params.rotator.markQuotaError(usedKey, errorText);
      } else if (classification.category === 'rate_limit') {
        params.rotator.markRateLimited(usedKey, errorText);
      } else {
        params.rotator.markError(usedKey, errorText);
      }
      if (result.lease) {
        params.rotator.release(result.lease);
      }
    }

    return response;
  }

  async countTokensViaProviderResponse(params: {
    provider: ResolvedProvider;
    route: ResolvedRoute;
    rotator?: ApiKeyRotator;
    openAIMessages: Array<Record<string, unknown>>;
    requestId: string;
    sessionId: string;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Promise<number> {
    const response = await this.postChatCompletions({
      provider: params.provider,
      route: params.route,
      rotator: params.rotator,
      requestId: params.requestId,
      sessionId: params.sessionId,
      anthropicVersion: params.anthropicVersion,
      anthropicBeta: params.anthropicBeta,
      payload: {
        model: params.route.upstream_model,
        messages: params.openAIMessages,
        max_tokens: 1,
        temperature: 0,
        stream: false
      }
    });

    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(`上游 token 统计失败：${JSON.stringify(data)}`);
    }
    const usage = isPlainObject(data.usage) ? data.usage : {};
    const promptTokens = Number(usage.prompt_tokens ?? NaN);
    if (!Number.isFinite(promptTokens)) {
      throw new Error('上游响应中不存在 usage.prompt_tokens');
    }
    return Math.trunc(promptTokens);
  }

  async countTokensAnthropic(params: {
    provider: ResolvedProvider;
    route: ResolvedRoute;
    rotator?: ApiKeyRotator;
    anthropicPayload: Record<string, unknown>;
    requestId: string;
    sessionId: string;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Promise<number> {
    const url = `${params.provider.base_url.replace(/\/$/, '')}/messages/count_tokens`;
    const body = JSON.stringify({
      ...params.anthropicPayload,
      model: params.route.upstream_model,
      ...params.route.extra_body
    });

    const result = await this.doFetch({
      url,
      provider: params.provider,
      rotator: params.rotator,
      payload: body,
      requestId: params.requestId,
      sessionId: params.sessionId,
      anthropicVersion: params.anthropicVersion,
      anthropicBeta: params.anthropicBeta,
    });

    try {
      const data = await safeJson(result.response);
      if (!result.response.ok) {
        if (params.rotator && result.lease) {
          const errorText = summarizeUpstreamError(result.response, JSON.stringify(data));
          const classification = classifyUpstreamError(result.response.status, result.response.statusText, JSON.stringify(data));
          if (classification.category === 'hard_limit') {
            params.rotator.markQuotaError(result.lease.key, errorText);
          } else if (classification.category === 'rate_limit') {
            params.rotator.markRateLimited(result.lease.key, errorText);
          } else {
            params.rotator.markError(result.lease.key, errorText);
          }
        }
        throw new Error(`上游 token 统计失败：${JSON.stringify(data)}`);
      }
      if (params.rotator && result.lease) {
        params.rotator.markSuccess(result.lease.key);
      }
      const inputTokens = Number(data.input_tokens ?? NaN);
      if (!Number.isFinite(inputTokens)) {
        throw new Error('上游响应中不存在 input_tokens');
      }
      return Math.trunc(inputTokens);
    } finally {
      if (params.rotator && result.lease) {
        params.rotator.release(result.lease);
      }
    }
  }
}

export async function safeJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

export function isQuotaLimitError(text: string): boolean {
  return classifyUpstreamError(400, '', text).category === 'hard_limit';
}

export function classifyUpstreamError(status: number, statusText: string, bodyText: string): { category: 'hard_limit' | 'rate_limit' | 'transient'; reason: string } {
  const normalized = bodyText.toLowerCase();
  const tokenLimit = [
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
  if (tokenLimit.some((keyword) => normalized.includes(keyword))) {
    return { category: 'rate_limit', reason: 'temporary token or request limit' };
  }

  const hardLimit = [
    'quota',
    'insufficient_quota',
    'insufficient quota',
    'billing hard limit',
    'usage limit',
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
    '超限',
    '超过限制',
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
  if (hardLimit.some((keyword) => normalized.includes(keyword))) {
    return { category: 'hard_limit', reason: 'hard limit or invalid key' };
  }

  const rateLimit = [
    'rate limit',
    'rate_limit',
    'ratelimit',
    'too many requests',
    '限流',
    '请求过多',
    '频率限制'
  ];
  if (status === 429 || rateLimit.some((keyword) => normalized.includes(keyword))) {
    return { category: 'rate_limit', reason: 'temporary rate limit' };
  }
  if (status === 401 || status === 403) {
    return { category: 'hard_limit', reason: statusText || 'unauthorized' };
  }
  return { category: 'transient', reason: statusText || 'transient upstream error' };
}

export function releaseUpstreamResponse(response: Response): void {
  const lease = responseLeases.get(response);
  if (!lease) return;
  lease.rotator.release(lease.lease);
  responseLeases.delete(response);
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.clone().text();
  } catch {
    return '';
  }
}

function summarizeUpstreamError(response: Response, bodyText: string): string {
  const detail = bodyText.trim().replace(/\s+/g, ' ').slice(0, settings.maxResponseBodyChars);
  return detail
    ? `${response.status} ${response.statusText}: ${detail}`
    : `${response.status} ${response.statusText}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
