import { settings } from '../config.js';
import type { ResolvedProvider, ResolvedRoute } from '../models.js';
import type { ApiKeyRotator } from './api-key-rotator.js';

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
      headers.set('authorization', `Bearer ${params.apiKey}`);
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
    const payload = this.buildPayload(params.route, params.payload);
    const url = this.buildChatCompletionsUrl(params.provider);
    const body = JSON.stringify(payload);

    const timeoutMs = payload.stream === true
      ? undefined
      : Math.max(1000, params.provider.timeout_seconds * 1000 || settings.requestTimeoutMs);

    const { response, usedKey } = this.doFetch({
      url,
      provider: params.provider,
      rotator: params.rotator,
      payload: body,
      timeoutMs,
      requestId: params.requestId,
      sessionId: params.sessionId,
      anthropicVersion: params.anthropicVersion,
      anthropicBeta: params.anthropicBeta,
    });

    const res = await response;

    // 429 重试：标记 key + 用下一个可用 key 重试一次
    if (res.status === 429 && params.rotator && usedKey && !params.rotator.allCoolingDown()) {
      params.rotator.mark429(usedKey);
      const { response: retryResponse } = this.doFetch({
        url,
        provider: params.provider,
        rotator: params.rotator,
        payload: body,
        timeoutMs,
        requestId: params.requestId,
        sessionId: params.sessionId,
        anthropicVersion: params.anthropicVersion,
        anthropicBeta: params.anthropicBeta,
      });
      return retryResponse;
    }

    return res;
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