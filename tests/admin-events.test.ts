import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdminEventStream,
  formatAdminEventSse,
  type AdminEvent,
} from '../src/services/admin-event-stream.js';
import { RuntimeConfigManager } from '../src/services/runtime-config.js';
import { createApp } from '../src/server.js';
import { settings } from '../src/config.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('AdminEventStream', () => {
  it('只回放有界历史中晚于 Last-Event-ID 的事件', () => {
    const events = new AdminEventStream(2, () => new Date('2026-07-18T08:00:00.000Z'));
    events.configChanged({ scope: 'settings', action: 'updated', revision: 2 });
    events.configChanged({ scope: 'provider', action: 'created', revision: 3, providerId: 'p1' });
    events.configChanged({ scope: 'route', action: 'created', revision: 4, routeId: 'r1' });

    const replayed: AdminEvent[] = [];
    const unsubscribe = events.subscribe(event => replayed.push(event), 2);
    unsubscribe();

    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ id: 3, type: 'config.changed' });
    expect(formatAdminEventSse(replayed[0])).toContain('id: 3\ndata: {');
  });

  it('请求摘要只接收代理请求和有副作用的管理操作', () => {
    const events = new AdminEventStream();
    const received: AdminEvent[] = [];
    const unsubscribe = events.subscribe(event => received.push(event));

    events.requestCompleted({ method: 'GET', route: '/api/config', statusCode: 200, durationMs: 1, ttfbMs: 1 });
    events.requestCompleted({ method: 'POST', route: '/api/config/preview', statusCode: 200, durationMs: 1, ttfbMs: 1 });
    events.requestCompleted({ method: 'POST', route: '/api/providers', statusCode: 200, durationMs: 7.8, ttfbMs: 2.2 });
    events.requestCompleted({ method: 'POST', route: '/v1/messages', statusCode: 201, durationMs: 12.4, ttfbMs: 3.7 });
    unsubscribe();

    expect(received).toHaveLength(2);
    expect(received.map(event => event.data.route)).toEqual(['/api/providers', '/v1/messages']);
    expect(received[0].data).toMatchObject({ duration_ms: 7, ttfb_ms: 2 });
  });

  it('运行时 Key 与配额事件不携带 Key 值或错误正文', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'admin-events-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'runtime_models.json');
    const secretKey = 'sk-runtime-super-secret';
    const secretError = 'Bearer upstream-sensitive-response';
    writeFileSync(configPath, JSON.stringify({
      revision: 1,
      providers: [{
        provider_id: 'provider-a',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com/v1',
        api_key: [{ id: 'KEYOBS0001', key: secretKey, enabled: true }],
        enabled: true,
      }],
      models: [{
        route_id: 'ROUTEOBS01',
        client_model: 'client-model',
        provider_id: 'provider-a',
        upstream_model: 'upstream-model',
        enabled: true,
      }],
      default_client_model: 'client-model',
    }), 'utf8');
    const events = new AdminEventStream();
    const manager = new RuntimeConfigManager(configPath);
    manager.setObserver(events);
    await manager.init();

    const { rotator } = manager.resolveModel('client-model');
    rotator.recordUsage(secretKey, 2, 17);
    rotator.markError(secretKey, secretError, 'network');
    const replayed: AdminEvent[] = [];
    const unsubscribe = events.subscribe(event => replayed.push(event));
    unsubscribe();
    await manager.shutdown();

    expect(replayed.map(event => event.type)).toEqual(['quota.changed', 'key.changed']);
    expect(replayed[0].data).toMatchObject({
      provider_id: 'provider-a',
      key_id: 'KEYOBS0001',
      requests_used: 2,
      tokens_used: 17,
    });
    const serialized = JSON.stringify(replayed);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain(secretError);
  });

  it('已登录管理会话可通过真实 SSE 连接接收事件', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'admin-events-route-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'runtime_models.json');
    writeFileSync(configPath, JSON.stringify({
      revision: 1,
      providers: [],
      models: [],
      default_client_model: null,
    }), 'utf8');
    const app = await createApp(configPath);
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(`${address}/api/admin/events`, {
        headers: {
          cookie: `${settings.adminCookieName}=${encodeURIComponent(settings.adminAuthToken)}`,
        },
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader!.read();
      expect(Buffer.from(first.value || []).toString('utf8')).toContain('retry: 3000');

      app.adminEventStream.configChanged({ scope: 'settings', action: 'updated', revision: 2 });
      const next = await reader!.read();
      const text = Buffer.from(next.value || []).toString('utf8');
      expect(text).toContain('config.changed');
      expect(text).toContain('"revision":2');
    } finally {
      abort.abort();
      await reader?.cancel().catch(() => undefined);
      await app.close();
      await app.runtimeConfigManager.shutdown();
    }
  });
});
