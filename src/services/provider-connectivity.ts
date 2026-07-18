import type { ResolvedProvider } from '../types/runtime-config.js';
import { getProviderAdapter, providerSupportsCapability } from './providers/provider-adapter.js';
import { normalizeAnthropicBaseUrl } from './upstream/url-builder.js';

export type ProviderTestCategory = 'ok' | 'auth' | 'rate_limit' | 'server' | 'http_error' | 'network' | 'unsupported';

export interface ProviderTestResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  category: ProviderTestCategory;
  message: string;
}

export interface ProviderConnectivityOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * 用无生成成本的模型列表请求验证 Provider 连通性。
 * 连接测试不复用生产 rotator lease，避免管理员点按测试改变 Key 并发、冷却或配额状态。
 */
export class ProviderConnectivityService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: ProviderConnectivityOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => performance.now());
    this.timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? 10_000, 10_000));
  }

  async test(provider: ResolvedProvider): Promise<ProviderTestResult> {
    if (!providerSupportsCapability(provider, 'models')) {
      return {
        ok: false,
        statusCode: null,
        latencyMs: 0,
        category: 'unsupported',
        message: '当前 Provider 未启用模型列表能力。',
      };
    }
    const url = buildModelsUrl(provider);
    const headers = new Headers(provider.headers);
    const key = provider.api_keys.find((entry) => entry.enabled !== false && !entry.disabled_at)?.key;
    if (key) getProviderAdapter(provider.provider_type).applyAuthentication(headers, key);
    headers.set('accept', 'application/json');
    headers.set('user-agent', 'claude-code-openai-proxy/provider-test');

    const startedAt = this.now();
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // 只需要状态码；主动取消响应体，避免某些网关返回大型模型列表占用内存。
      await response.body?.cancel().catch(() => undefined);
      const latencyMs = elapsedMs(this.now(), startedAt);
      const category = classifyStatus(response.status);
      return {
        ok: category === 'ok',
        statusCode: response.status,
        latencyMs,
        category,
        message: messageForCategory(category, response.status),
      };
    } catch {
      return {
        ok: false,
        statusCode: null,
        latencyMs: elapsedMs(this.now(), startedAt),
        category: 'network',
        message: '无法连接 Provider，请检查地址、网络和 TLS 配置。',
      };
    }
  }
}

function buildModelsUrl(provider: ResolvedProvider): string {
  const base = provider.provider_type === 'anthropic'
    ? normalizeAnthropicBaseUrl(provider.base_url)
    : provider.base_url.replace(/\/+$/, '');
  return `${base}/models`;
}

function classifyStatus(status: number): ProviderTestCategory {
  if (status >= 200 && status < 400) return 'ok';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'http_error';
}

function messageForCategory(category: ProviderTestCategory, status: number): string {
  switch (category) {
    case 'ok': return 'Provider 连接成功。';
    case 'auth': return `Provider 拒绝认证（HTTP ${status}），请检查 API Key。`;
    case 'rate_limit': return `Provider 当前限流（HTTP ${status}），地址已连通。`;
    case 'server': return `Provider 返回服务端错误（HTTP ${status}），地址已连通。`;
    default: return `Provider 返回 HTTP ${status}，请检查 API 类型和地址。`;
  }
}

function elapsedMs(now: number, startedAt: number): number {
  return Math.max(0, Math.round(now - startedAt));
}
