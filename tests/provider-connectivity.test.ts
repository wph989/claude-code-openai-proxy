import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../src/config.js';
import { createApp } from '../src/server.js';
import { ProviderConnectivityService } from '../src/services/provider-connectivity.js';
import type { ResolvedProvider } from '../src/types/runtime-config.js';

const tempDirs: string[] = [];
const authCookies = { [settings.adminCookieName]: settings.adminAuthToken };

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function provider(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    provider_id: 'provider-test',
    provider_type: 'openai_compatible',
    base_url: 'https://example.com/v1/',
    api_keys: [{ id: 'KEYTEST001', key: 'sk-test-secret', enabled: true }],
    key_rotation_strategy: 'round_robin' as ResolvedProvider['key_rotation_strategy'],
    auto_disable_on_error: true,
    auto_recover_minutes: 0,
    timeout_seconds: 30,
    stream_idle_timeout_seconds: 120,
    enabled: true,
    headers: { 'x-custom-secret': 'do-not-return' },
    anti_ban: {} as ResolvedProvider['anti_ban'],
    description: '',
    ...overrides,
  };
}

describe('ProviderConnectivityService', () => {
  it('用 OpenAI 兼容的 GET /models 和 Bearer 认证测试，不读取响应正文', async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('https://example.com/v1/models');
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-test-secret');
      return new Response('{"data":[{"id":"model"}]}', { status: 200 });
    });
    const service = new ProviderConnectivityService({
      fetchImpl,
      now: (() => { let value = 100; return () => (value += 8); })(),
    });

    await expect(service.test(provider())).resolves.toMatchObject({
      ok: true,
      statusCode: 200,
      category: 'ok',
      latencyMs: 8,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('按显式 Anthropic 类型规范化 /v1 并使用 x-api-key', async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(String(input)).toBe('https://anthropic.example.com/v1/models');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('sk-test-secret');
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      return new Response(null, { status: 401 });
    });
    const service = new ProviderConnectivityService({ fetchImpl });

    await expect(service.test(provider({
      provider_type: 'anthropic',
      base_url: 'https://anthropic.example.com',
    }))).resolves.toMatchObject({
      ok: false,
      statusCode: 401,
      category: 'auth',
    });
  });

  it('网络失败只返回通用诊断，不暴露异常正文', async () => {
    const secret = 'https://secret.example/internal?token=should-not-leak';
    const service = new ProviderConnectivityService({
      fetchImpl: vi.fn(async () => { throw new Error(secret); }),
    });

    const result = await service.test(provider());
    expect(result).toMatchObject({ ok: false, statusCode: null, category: 'network' });
    expect(result.message).not.toContain(secret);
  });
});

describe('Provider test admin route', () => {
  it('只用管理员会话执行探测，并发布脱敏连接事件', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'provider-test-route-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'runtime_models.json');
    writeFileSync(configPath, JSON.stringify({
      revision: 1,
      providers: [{
        provider_id: 'provider-a',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com/v1',
        api_key: [],
        enabled: true,
      }],
      models: [],
      default_client_model: null,
    }), 'utf8');
    const connectivity = new ProviderConnectivityService({
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })),
    });
    const app = await createApp(configPath, { providerConnectivity: connectivity });
    try {
      const denied = await app.inject({ method: 'POST', url: '/api/providers/provider-a/test' });
      expect(denied.statusCode).toBe(401);

      const response = await app.inject({
        method: 'POST',
        url: '/api/providers/provider-a/test',
        cookies: authCookies,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ provider_id: 'provider-a', ok: true, statusCode: 204 });

      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const unsubscribe = app.adminEventStream.subscribe(event => events.push(event));
      unsubscribe();
      const tested = events.find(event => event.type === 'provider.tested');
      expect(tested?.data).toMatchObject({ provider_id: 'provider-a', ok: true, status_code: 204 });
      expect(JSON.stringify(events)).not.toContain('secret');
    } finally {
      await app.close();
      await app.runtimeConfigManager.shutdown();
    }
  });
});
