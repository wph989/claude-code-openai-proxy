import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createMigratedApp } from './test-app.js';
import { WebhookAlertService } from '../src/services/alerts.js';

describe('WebhookAlertService', () => {
  it('预算达到阈值后发送脱敏摘要，并在冷却窗口内去重', async () => {
    let now = 1_000;
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const service = new WebhookAlertService({
      url: 'https://hooks.example.test/signed-secret',
      budgetThreshold: 0.8,
      cooldownMs: 300,
      fetcher: fetcher as typeof fetch,
      now: () => now,
    });
    const event = {
      providerId: 'provider-a',
      usage: { requests_used: 3, tokens_used: 70, cost_usd: 0.0011 },
      ratio: 0.85,
      blocked: false,
      reason: null,
    };

    service.keyBudget({ ...event, ratio: 0.79 });
    service.keyBudget(event);
    service.keyBudget(event);
    await service.flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, options] = fetcher.mock.calls[0];
    const payload = JSON.parse(String(options?.body));
    expect(payload).toMatchObject({
      type: 'budget.threshold',
      provider_id: 'provider-a',
      usage: { requests_used: 3, tokens_used: 70, cost_usd: 0.0011, ratio: 0.85 },
    });
    expect(JSON.stringify(payload)).not.toMatch(/key_id|model|request_id|token_value|secret/i);

    now += 301;
    service.keyBudget(event);
    await service.flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('Provider 熔断告警只包含聚合状态', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    const service = new WebhookAlertService({
      url: 'https://hooks.example.test/alert',
      budgetThreshold: 0.8,
      cooldownMs: 300_000,
      fetcher: fetcher as typeof fetch,
      now: () => 2_000,
    });

    service.providerCircuitOpened('provider-a', {
      state: 'open',
      consecutiveFailures: 3,
      openUntil: 32_000,
    });
    await service.flush();
    const payload = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(payload).toEqual({
      type: 'provider.circuit_opened',
      timestamp: '1970-01-01T00:00:02.000Z',
      provider_id: 'provider-a',
      consecutive_failures: 3,
      open_until: 32_000,
    });
  });

  it('应用层把 Manager 用量和 Provider 熔断接入同一脱敏 AlertSink', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'ccop-alert-integration-'));
    const configPath = path.join(tempDir, 'runtime_models.json');
    const keyBudget = vi.fn();
    const providerCircuitOpened = vi.fn();
    writeFileSync(configPath, JSON.stringify({
      revision: 1,
      providers: [{
        provider_id: 'provider-alert',
        provider_type: 'openai_compatible',
        base_url: 'https://example.com/v1',
        api_key: [{
          id: 'ALERTKEY01',
          key: 'secret-key-must-not-leak',
          quota: { max_requests: null, max_tokens: 10, soft_stop_threshold: 1 },
        }],
        circuit_breaker: { failure_threshold: 1, recovery_seconds: 30 },
        enabled: true,
      }],
      models: [{
        route_id: 'ALERTROUTE',
        client_model: 'private-client-model',
        provider_id: 'provider-alert',
        upstream_model: 'private-upstream-model',
        enabled: true,
      }],
      default_client_model: 'private-client-model',
    }), 'utf8');

    const app = await createMigratedApp(configPath, {
      alertSink: { keyBudget, providerCircuitOpened },
    });
    try {
      const { rotator } = app.runtimeConfigManager.resolveModel('private-client-model');
      rotator.recordUsage('secret-key-must-not-leak', 1, 10, { inputTokens: 6, outputTokens: 4 });
      expect(keyBudget).toHaveBeenCalledWith(expect.objectContaining({
        providerId: 'provider-alert',
        ratio: 1,
        blocked: true,
        usage: { requests_used: 1, tokens_used: 10 },
      }));

      const lease = app.providerHealth.acquire('provider-alert');
      expect(lease).not.toBeNull();
      app.providerHealth.recordFailure('provider-alert', 'network', lease ?? undefined);
      expect(providerCircuitOpened).toHaveBeenCalledWith(
        'provider-alert',
        expect.objectContaining({ state: 'open', consecutiveFailures: 1 }),
      );

      const serializedCalls = JSON.stringify({
        keyBudget: keyBudget.mock.calls,
        providerCircuitOpened: providerCircuitOpened.mock.calls,
      });
      expect(serializedCalls).not.toMatch(/secret-key|private-client-model|private-upstream-model|request_id|key_id/i);
    } finally {
      await app.runtimeConfigManager.shutdown();
      await app.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
