import { setGlobalDispatcher, Agent } from 'undici';
import { settings } from '../config.js';
import type { ResolvedProvider, ResolvedRoute } from '../models.js';
import type { ApiKeyRotator } from './api-key-rotator.js';
import { log } from '../utils/logger.js';

// 设置全局连接池配置
const agent = new Agent({
  keepAliveTimeout: settings.keepAliveTimeout,
  keepAliveMaxTimeout: settings.keepAliveTimeout * 2,
  connections: settings.maxSockets,
  pipelining: 1
});
setGlobalDispatcher(agent);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

  private doFetch(params: {
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
  }): { response: Promise<Response>; usedKey: string | undefined } {
    const apiKey = params.rotator?.pick();
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
    return { response: fetch(params.url, fetchParams), usedKey: apiKey };
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

    let lastResponse: Response | null = null;
    let usedKey: string | undefined;

    for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(
          settings.retryBaseDelayMs * Math.pow(2, attempt - 1),
          30000
        );
        log('info', '重试请求（指数退避）', {
          attempt,
          delay_ms: delay,
          url: params.url
        });
        await sleep(delay);
      }

      if (params.rotator && !params.rotator.hasAvailableKey()) {
        if (lastResponse) return lastResponse;
        throw new Error(`供应商 ${params.provider.provider_id} 的所有 API Key 均不可用`);
      }

      const result = this.doFetch({
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

      lastResponse = await result.response;
      usedKey = result.usedKey;

      if (lastResponse.ok) {
        if (params.rotator && usedKey) {
          params.rotator.markSuccess(usedKey);
        }
        return lastResponse;
      }

      if (params.rotator && usedKey) {
        const errorText = `${lastResponse.status} ${lastResponse.statusText}`;
        params.rotator.markError(usedKey, errorText);
      }

      if (!params.rotator || params.rotator.allUnavailable()) {
        return lastResponse;
      }
    }

    return lastResponse!;
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

    const { response } = this.doFetch({
      url,
      provider: params.provider,
      rotator: params.rotator,
      payload: body,
      requestId: params.requestId,
      sessionId: params.sessionId,
      anthropicVersion: params.anthropicVersion,
      anthropicBeta: params.anthropicBeta,
    });

    const res = await response;
    const data = await safeJson(res);
    if (!res.ok) {
      throw new Error(`上游 token 统计失败：${JSON.stringify(data)}`);
    }
    const inputTokens = Number(data.input_tokens ?? NaN);
    if (!Number.isFinite(inputTokens)) {
      throw new Error('上游响应中不存在 input_tokens');
    }
    return Math.trunc(inputTokens);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}