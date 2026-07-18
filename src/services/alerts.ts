import type { Logger } from '../utils/logger.js';
import type { KeyUsage } from '../types/runtime-config.js';
import type { ProviderCircuitSnapshot } from './provider-health.js';

export interface KeyBudgetAlert {
  providerId: string;
  usage: KeyUsage;
  ratio: number;
  blocked: boolean;
  reason: string | null;
}

export interface AlertSink {
  keyBudget(event: KeyBudgetAlert): void;
  providerCircuitOpened(providerId: string, snapshot: ProviderCircuitSnapshot): void;
}

export const NOOP_ALERTS: AlertSink = {
  keyBudget: () => undefined,
  providerCircuitOpened: () => undefined,
};

export interface WebhookAlertServiceOptions {
  url: string | null;
  budgetThreshold: number;
  cooldownMs: number;
  logger?: Logger;
  fetcher?: typeof fetch;
  now?: () => number;
}

/**
 * 出站 Webhook 只发送低基数运行摘要。URL 可能自带签名，因此从不放进日志、事件或管理 DTO。
 */
export class WebhookAlertService implements AlertSink {
  private readonly lastSentAt = new Map<string, number>();
  private readonly pending = new Set<Promise<void>>();
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: WebhookAlertServiceOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  isConfigured(): boolean {
    return Boolean(this.options.url);
  }

  keyBudget(event: KeyBudgetAlert): void {
    if (!this.options.url || event.ratio < this.options.budgetThreshold) return;
    this.enqueue(`budget:${event.providerId}:${event.reason || 'threshold'}`, {
      type: 'budget.threshold',
      timestamp: new Date(this.now()).toISOString(),
      provider_id: event.providerId,
      usage: {
        requests_used: event.usage.requests_used,
        tokens_used: event.usage.tokens_used,
        cost_usd: round(event.usage.cost_usd ?? 0),
        ratio: round(event.ratio),
      },
      blocked: event.blocked,
      reason: event.reason,
    });
  }

  providerCircuitOpened(providerId: string, snapshot: ProviderCircuitSnapshot): void {
    if (!this.options.url || snapshot.state !== 'open') return;
    this.enqueue(`circuit:${providerId}`, {
      type: 'provider.circuit_opened',
      timestamp: new Date(this.now()).toISOString(),
      provider_id: providerId,
      consecutive_failures: snapshot.consecutiveFailures,
      open_until: snapshot.openUntil,
    });
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending);
  }

  private enqueue(dedupeKey: string, payload: Record<string, unknown>): void {
    const now = this.now();
    const lastSentAt = this.lastSentAt.get(dedupeKey) ?? Number.NEGATIVE_INFINITY;
    if (now - lastSentAt < this.options.cooldownMs) return;
    this.lastSentAt.set(dedupeKey, now);
    const task = this.send(payload).finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  private async send(payload: Record<string, unknown>): Promise<void> {
    try {
      const response = await this.fetcher(this.options.url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        this.options.logger?.log('warn', 'Webhook 告警发送失败', {
          event_type: String(payload.type || 'unknown'),
          status: response.status,
        });
      }
    } catch (error) {
      this.options.logger?.log('warn', 'Webhook 告警发送失败', {
        event_type: String(payload.type || 'unknown'),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0;
}
