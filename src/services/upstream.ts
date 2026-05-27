import { settings } from '../config.js';
import type { ResolvedProvider, ResolvedRoute } from '../models.js';
import type { ApiKeyRotator } from './api-key-rotator.js';
import { log } from '../utils/logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 上游请求服务：
 * - 统一构造 OpenAI-compatible 请求
 * - 流式请求自动打开 include_usage，便于从供应商响应中提取 token
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
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Headers {
    const headers = new Headers();
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');
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

  buildPayload(route: ResolvedRoute, payload: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = {
      ...payload,
      model: route.upstream_model,
      ...route.extra_body
    };
    if (merged.stream === true) {
      merged.stream_options = {
        include_usage: true,
        ...(isPlainObject(merged.stream_options) ? merged.stream_options as Record<string, unknown> : {})
      };
    }
    return merged;
  }

  async postChatCompletions(params: {
    provider: ResolvedProvider;
    route: ResolvedRoute;
    rotator?: ApiKeyRotator;
    payload: Record<string, unknown>;
    requestId: string;
    sessionId: string;
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
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Promise<Response> {
    const payload = this.buildPayload(params.route, params.payload);
    const body = JSON.stringify(payload);

    const timeoutMs = payload.stream === true
      ? undefined
      : Math.max(1000, params.provider.timeout_seconds * 1000 || settings.requestTimeoutMs);

    let lastResponse: Response | null = null;
    let usedKey: string | undefined;

    for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
      // If not the first attempt, wait with exponential backoff
      if (attempt > 0) {
        const delay = Math.min(
          settings.retryBaseDelayMs * Math.pow(2, attempt - 1),
          30000 // Max 30 seconds
        );
        log('info', '重试请求（指数退避）', {
          request_id: params.requestId,
          attempt,
          delay_ms: delay,
          url: params.url
        });
        await sleep(delay);
      }

      const result = this.doFetch({
        url: params.url,
        provider: params.provider,
        rotator: params.rotator,
        payload: body,
        timeoutMs,
        requestId: params.requestId,
        sessionId: params.sessionId,
        anthropicVersion: params.anthropicVersion,
        anthropicBeta: params.anthropicBeta,
      });

      lastResponse = await result.response;
      usedKey = result.usedKey;

      // If not rate limited, return immediately
      if (lastResponse.status !== 429) {
        return lastResponse;
      }

      // Mark the key as rate limited
      if (params.rotator && usedKey) {
        params.rotator.mark429(usedKey);
      }

      // If no more keys available, return the 429 response
      if (!params.rotator || params.rotator.allCoolingDown()) {
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