import { setGlobalDispatcher, Agent } from 'undici';
import { settings } from '../config.js';
import type { ResolvedProvider, ResolvedRoute } from '../models.js';
import type { ApiKeyRotator, KeyLease } from './api-key-rotator.js';
import { getDefaultLogger, type Logger } from '../utils/logger.js';
import { isPlainObject } from '../utils/guards.js';
import { buildForwardRequestHeaders } from './http-headers.js';
import {
  classifyUpstreamError,
  isQuotaLimitError,
  type UpstreamErrorClassification,
} from './upstream/error-classifier.js';
import { normalizeAnthropicBaseUrl } from './upstream/url-builder.js';
import { getProviderAdapter } from './providers/provider-adapter.js';
import { NOOP_METRICS, type MetricsSink } from './metrics.js';
import {
  attachResponseMeta,
  markUpstreamResponseStreamError,
  releaseUpstreamResponse,
} from './upstream/response-meta.js';

// 历史兼容：早期路由 / passthrough 从 'upstream.js' 直接导入这些工具。
// 经过重构后实际实现已经搬到 ./upstream/* 子模块，这里集中 re-export 保留旧 import。
export {
  classifyUpstreamError,
  isQuotaLimitError,
  markUpstreamResponseStreamError,
  releaseUpstreamResponse,
};
export type { UpstreamErrorClassification };

const agent = new Agent({
  keepAliveTimeout: settings.keepAliveTimeout,
  keepAliveMaxTimeout: settings.keepAliveTimeout * 2,
  connections: settings.maxSockets,
  pipelining: 1
});
setGlobalDispatcher(agent);

/**
 * 上游请求服务：
 * - 保留原始请求 headers 和 body，仅替换 auth、model 等必要字段
 * - 支持多 API Key 轮询和 429 自动切换
 * - 错误分类 / URL 构造 / lease 元数据分别拆到 ./upstream/* 子模块
 */
export class UpstreamService {
  constructor(
    private readonly logger: Logger = getDefaultLogger(),
    private readonly metrics: MetricsSink = NOOP_METRICS,
  ) {}

  buildChatCompletionsUrl(provider: ResolvedProvider): string {
    return getProviderAdapter(provider.provider_type).buildChatCompletionsUrl(provider);
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
    return buildForwardRequestHeaders(params);
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
      url: getProviderAdapter(params.provider.provider_type).buildChatCompletionsUrl(params.provider)
    });
  }

  async postMessages(params: {
    provider: ResolvedProvider;
    route: ResolvedRoute;
    rotator?: ApiKeyRotator;
    payload: Record<string, unknown> | string;
    requestId: string;
    sessionId: string;
    incomingHeaders?: Record<string, string | string[] | undefined>;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Promise<Response> {
    return this.postToUpstream({
      ...params,
      url: getProviderAdapter(params.provider.provider_type).buildMessagesUrl(params.provider)
    });
  }

  private async postToUpstream(params: {
    provider: ResolvedProvider;
    route: ResolvedRoute;
    rotator?: ApiKeyRotator;
    payload: Record<string, unknown> | string;
    url: string;
    requestId: string;
    sessionId: string;
    incomingHeaders?: Record<string, string | string[] | undefined>;
    anthropicVersion?: string;
    anthropicBeta?: string;
  }): Promise<Response> {
    const body = typeof params.payload === 'string' ? params.payload : JSON.stringify(params.payload);

    const isStream = typeof params.payload === 'string'
      ? body.includes('"stream":true')
      : params.payload.stream === true;
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
        this.metrics.recordUpstreamError(params.provider.provider_type, 'network');
        if (retry.retry_on_transient) {
          this.logger.log('warn', '上游网络错误，准备按 transient 策略重试', {
            provider_id: params.provider.provider_id,
            attempt: attempt + 1,
            max_attempts: retry.max_attempts,
            error: error instanceof Error ? error.message : String(error)
          });
          if (attempt < retry.max_attempts - 1 && Date.now() < deadline) {
            this.metrics.recordUpstreamRetry(params.provider.provider_type, 'network');
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
            attachResponseMeta(response, { rotator: params.rotator, key: usedKey, lease: result.lease });
          } else {
            attachResponseMeta(response, { rotator: params.rotator, key: usedKey });
            if (result.lease) params.rotator.release(result.lease);
          }
        }
        return response;
      }

      const bodyText = await readResponseText(response);
      const errorText = summarizeUpstreamError(response, bodyText);
      const classification = classifyUpstreamError(response.status, response.statusText, bodyText);
      this.metrics.recordUpstreamError(params.provider.provider_type, classification.category);

      // 排查 429 / 4xx 自动禁用是否生效：把分类结果与原始 body 一起打出来。
      this.logger.log('warn', '上游错误响应分类', {
        provider_id: params.provider.provider_id,
        status: response.status,
        status_text: response.statusText,
        category: classification.category,
        reason: classification.reason,
        used_key: usedKey ? usedKey.slice(0, 6) + '***' : null,
        body_preview: bodyText.slice(0, 500)
      });

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

      // hard_limit 表示当前 Key 不可继续使用；有 rotator 时应先切换到下一个健康 Key，
      // 避免单个 Key 额度耗尽或失效直接中断下游客户端。
      if (classification.category === 'hard_limit' && !params.rotator) return response;
      if (classification.category === 'request_limit') return response;
      if (classification.category === 'rate_limit' && !retry.retry_on_rate_limit) return response;
      if (classification.category === 'transient' && !retry.retry_on_transient) return response;
      if (attempt < retry.max_attempts - 1 && Date.now() < deadline) {
        this.metrics.recordUpstreamRetry(params.provider.provider_type, classification.category);
      }
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
    const url = getProviderAdapter(params.provider.provider_type).buildCountTokensUrl(params.provider);
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
          const errorBody = JSON.stringify(data);
          const errorText = summarizeUpstreamError(result.response, errorBody);
          const classification = classifyUpstreamError(result.response.status, result.response.statusText, errorBody);
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


// 历史兼容：早期 normalizeAnthropicBaseUrl 通过 upstream.ts 暴露给少数模块直接调用，
// 拆出 url-builder 后保留这个 re-export。
export { normalizeAnthropicBaseUrl };
