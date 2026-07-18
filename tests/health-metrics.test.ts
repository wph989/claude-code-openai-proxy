import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'health-metrics-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('存活、就绪与指标端点', () => {
  it('区分 live/readiness，保留 healthz 兼容入口并采集路由模板', async () => {
    const configPath = path.join(tempDir, 'runtime_models.json');
    writeFileSync(configPath, JSON.stringify({
      revision: 3,
      providers: [],
      models: [],
      default_client_model: null,
    }), 'utf8');
    const app = await createApp(configPath);
    try {
      expect((await app.inject({ method: 'GET', url: '/livez' })).json()).toEqual({ status: 'ok' });
      expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toEqual({ status: 'ok' });
      const ready = await app.inject({ method: 'GET', url: '/readyz' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: 'ready', revision: 3 });

      await app.inject({ method: 'GET', url: '/missing?token=must-not-leak' });
      const metrics = await app.inject({ method: 'GET', url: '/metrics' });
      expect(metrics.statusCode).toBe(200);
      expect(metrics.headers['content-type']).toContain('text/plain');
      expect(metrics.body).toContain('route="/livez"');
      expect(metrics.body).toContain('route="unmatched"');
      expect(metrics.body).not.toContain('must-not-leak');

      await app.runtimeConfigManager.shutdown();
      const notReady = await app.inject({ method: 'GET', url: '/readyz' });
      expect(notReady.statusCode).toBe(503);
      expect(notReady.json()).toEqual({ status: 'not_ready' });
    } finally {
      await app.close();
    }
  });
});
