import { setGlobalDispatcher, Agent } from 'undici';
import { settings } from '../config.js';
import type { ResolvedProvider, ResolvedRoute } from '../models.js';
import type { ApiKeyRotator, KeyLease } from './api-key-rotator.js';
import { log } from '../utils/logger.js';

interface ResponseMeta {
  rotator: ApiKeyRotator;
  key: string;
  lease?: KeyLease;
}

type UpstreamErrorCategory = 'hard_limit' | 'rate_limit' | 'transient' | 'request_limit';

const responseMeta = new WeakMap<Response, ResponseMeta>();

const agent = new Agent({
  keepAliveTimeout: settings.keepAliveTimeout,
  keepAliveMaxTimeout: settings.keepAliveTimeout * 2,
  connections: settings.maxSockets,
  pipelining: 1
});
setGlobalDispatcher(agent);

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
    acquireDeadline?: number;
    requestId: string;
    sessionId: string;
    incomingHeaders?: Record<string, string | string[] | undefined>;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Promise<{ response: Response; lease: KeyLease | undefined }> {
    const lease = params.rotator ? await params.rotator.acquire({ deadline: params.acquireDeadline }) : undefined;
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
        params.rotator.markError(lease.key, error instanceof Error ? error.message : String(error), 'network');
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
    const isStream = params.payload.stream === true;
    const timeoutMs = isStream
      ? undefined
      : Math.max(1000, params.provider.timeout_seconds * 1000 || settings.requestTimeoutMs);

    const retry = params.provider.anti_ban.retry;
    const deadline = Date.now() + retry.max_total_ms;
    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt < retry.max_attempts; attempt++) {
      if (attempt > 0 && Date.now() >= deadline) break;

      if (params.rotator && !params.rotator.hasAvailableKey()) {
        if (lastResponse) return lastResponse;
        throw new Error(`供应商 ${params.provider.provider_id} 的所有 API Key 均不可用`);
      }

      let result: { response: Response; lease: KeyLease | undefined };
      try {
        result = await this.doFetch({
          url: params.url,
          provider: params.provider,
          rotator: params.rotator,
          payload: body,
          timeoutMs,
          acquireDeadline: deadline,
          requestId: params.requestId,
          sessionId: params.sessionId,
          incomingHeaders: params.incomingHeaders,
          anthropicVersion: params.anthropicVersion,
          anthropicBeta: params.anthropicBeta,
        });
      } catch (error) {
        if (isAcquireTimeout(error)) {
          return lastResponse ?? new Response('waiting for available API Key timed out', { status: 503, statusText: 'Service Unavailable' });
        }
        if (retry.retry_on_transient) {
          log('warn', '上游网络错误，准备按 transient 策略重试', {
            provider_id: params.provider.provider_id,
            attempt: attempt + 1,
            max_attempts: retry.max_attempts,
            error: error instanceof Error ? error.message : String(error)
          });
          if (attempt < retry.max_attempts - 1 && Date.now() < deadline) {
            continue;
          }
          return lastResponse ?? new Response(error instanceof Error ? error.message : String(error), { status: 502, statusText: 'Bad Gateway' });
        }
        throw error;
      }

      const response = result.response;
      const usedKey = result.lease?.key;

      if (response.ok) {
        if (params.rotator && usedKey) {
          params.rotator.markSuccess(usedKey);
          if (isStream && result.lease) {
            responseMeta.set(response, { rotator: params.rotator, key: usedKey, lease: result.lease });
          } else {
            responseMeta.set(response, { rotator: params.rotator, key: usedKey });
            if (result.lease) params.rotator.release(result.lease);
          }
        }
        return response;
      }

      const bodyText = await readResponseText(response);
      const errorText = summarizeUpstreamError(response, bodyText);
      const classification = classifyUpstreamError(response.status, response.statusText, bodyText);

      // 排查 429 / 4xx 自动禁用是否生效：把分类结果与原始 body 一起打出来。
      if (!response.ok) {
        log('warn', '上游错误响应分类', {
          provider_id: params.provider.provider_id,
          status: response.status,
          status_text: response.statusText,
          category: classification.category,
          reason: classification.reason,
          used_key: usedKey ? usedKey.slice(0, 6) + '***' : null,
          body_preview: bodyText.slice(0, 500)
        });
      }

      if (params.rotator && usedKey) {
        if (classification.category === 'hard_limit') {
          params.rotator.markQuotaError(usedKey, errorText);
        } else if (classification.category === 'rate_limit') {
          params.rotator.markRateLimited(usedKey, errorText);
        } else if (classification.category === 'transient') {
          params.rotator.markError(usedKey, errorText);
        }
        if (result.lease) params.rotator.release(result.lease);
      }

      lastResponse = response;

      if (classification.category === 'hard_limit') return response;
      if (classification.category === 'request_limit') return response;
      if (classification.category === 'rate_limit' && !retry.retry_on_rate_limit) return response;
      if (classification.category === 'transient' && !retry.retry_on_transient) return response;
    }

    return lastResponse ?? new Response('upstream retry exhausted with no response', { status: 502 });
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
      acquireDeadline: Date.now() + params.provider.timeout_seconds * 1000,
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
          } else if (classification.category === 'transient') {
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

export function classifyUpstreamError(status: number, statusText: string, bodyText: string): { category: UpstreamErrorCategory; reason: string } {
  const normalized = bodyText.toLowerCase();

  // hardLimit 必须最先判：quota / insufficient / 账号封禁 等是真正不可恢复，
  // 不能被「token limit」「context length」这类同样含 limit 字样的临时错误抢先。
  const hardLimit = [
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
  if (hardLimit.some((keyword) => normalized.includes(keyword))) {
    return { category: 'hard_limit', reason: 'hard limit or invalid key' };
  }

  // 上下文 / 输入过长不是 key 的问题，换 key 只会额外消耗配额并污染健康分。
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
    return { category: 'request_limit', reason: 'request token or context limit' };
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

export function releaseUpstreamResponse(response: Response, usage?: { requests: number; tokens: number }): void {
  const meta = responseMeta.get(response);
  if (!meta) return;
  if (usage) meta.rotator.recordUsage(meta.key, usage.requests, usage.tokens);
  if (meta.lease) meta.rotator.release(meta.lease);
  responseMeta.delete(response);
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

function isAcquireTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes('等待可用 API Key 超时');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
