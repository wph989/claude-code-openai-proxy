import { settings } from '../config.js';
import type { ResolvedProvider, ResolvedRoute } from '../models.js';

/**
 * 上游请求服务：
 * - 统一构造 OpenAI-compatible 请求
 * - 流式请求自动打开 include_usage，便于从供应商响应中提取 token
 */
export class UpstreamService {
  buildChatCompletionsUrl(provider: ResolvedProvider): string {
    return `${provider.base_url.replace(/\/$/, '')}/chat/completions`;
  }

  buildHeaders(params: {
    provider: ResolvedProvider;
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

    if (params.provider.api_key) {
      headers.set('authorization', `Bearer ${params.provider.api_key}`);
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

  buildPayload(route: ResolvedRoute, payload: Record<string, unknown>): Record<string, unknown> {
    const merged = {
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
    payload: Record<string, unknown>;
    requestId: string;
    sessionId: string;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Promise<Response> {
    const payload = this.buildPayload(params.route, params.payload);
    const url = this.buildChatCompletionsUrl(params.provider);
    return fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(params),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(1000, params.provider.timeout_seconds * 1000 || settings.requestTimeoutMs))
    });
  }

  async countTokensViaProviderResponse(params: {
    provider: ResolvedProvider;
    route: ResolvedRoute;
    openAIMessages: Array<Record<string, unknown>>;
    requestId: string;
    sessionId: string;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Promise<number> {
    const response = await this.postChatCompletions({
      provider: params.provider,
      route: params.route,
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
