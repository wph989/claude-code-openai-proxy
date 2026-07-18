import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApi, ApiClientError } from '../src/static/api-client.js';

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  (globalThis as { window: { location: { href: string } } }).window = { location: { href: '' } };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
  vi.restoreAllMocks();
});

describe('管理端 API Client', () => {
  it('统一解析 JSON 与 ETag revision', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ config: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', etag: '"12"' },
    })) as typeof fetch;

    await expect(AdminApi.loadConfig()).resolves.toEqual({ data: { config: {} }, revision: 12 });
  });

  it('保留 409 响应数据供界面展示冲突', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ message: '配置冲突', revision: 9 }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    try {
      await AdminApi.saveConfig({ providers: [], models: [] }, 8);
      throw new Error('预期请求失败');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError);
      expect(error).toMatchObject({ status: 409, data: { revision: 9 } });
    }
  });

  it('任一管理请求收到 401 时统一跳转登录页', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ message: '会话失效' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    await expect(AdminApi.loadKeys('p1')).rejects.toMatchObject({ status: 401 });
    expect((globalThis as { window: { location: { href: string } } }).window.location.href).toBe('/login');
  });
});
