import { describe, expect, it, vi } from 'vitest';
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
});
