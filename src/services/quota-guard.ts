import type { KeyQuotaConfig, KeyUsage } from '../models.js';
import {
  addUsageDelta,
  emptyUsage,
  evaluateUsageQuota,
  normalizeUsage,
  type KeyUsageDelta,
} from './usage-budget.js';

interface State {
  usage: KeyUsage;
  quota: KeyQuotaConfig | null;
  lastReason: string | null;
}

export class QuotaGuard {
  private states = new Map<string, State>();

  setQuota(key: string, quota: KeyQuotaConfig | null): void {
    const s = this.ensure(key);
    s.quota = quota;
    this.evaluate(key);
  }

  hydrate(key: string, usage: KeyUsage): void {
    const s = this.ensure(key);
    s.usage = normalizeUsage(usage);
    this.evaluate(key);
  }

  recordUsage(key: string, deltaOrRequests: KeyUsageDelta | number, tokens = 0): void {
    const s = this.ensure(key);
    const delta = typeof deltaOrRequests === 'number'
      ? { requests: deltaOrRequests, tokens }
      : deltaOrRequests;
    s.usage = addUsageDelta(s.usage, delta, s.quota);
    this.evaluate(key);
  }

  isBlocked(key: string): boolean {
    return this.lastBlockReason(key) !== null;
  }

  lastBlockReason(key: string): string | null {
    return this.states.get(key)?.lastReason ?? null;
  }

  getRatio(key: string): number {
    const s = this.states.get(key);
    return s ? evaluateUsageQuota(s.usage, s.quota).ratio : 0;
  }

  getUsage(key: string): KeyUsage {
    const s = this.states.get(key);
    return s ? { ...s.usage } : { requests_used: 0, tokens_used: 0 };
  }

  getQuota(key: string): KeyQuotaConfig | null {
    return this.states.get(key)?.quota ?? null;
  }

  reset(key: string): void {
    const s = this.ensure(key);
    s.usage = emptyUsage(s.quota);
    s.lastReason = null;
  }

  private ensure(key: string): State {
    let s = this.states.get(key);
    if (!s) {
      s = { usage: emptyUsage(), quota: null, lastReason: null };
      this.states.set(key, s);
    }
    return s;
  }

  private evaluate(key: string): void {
    const s = this.ensure(key);
    s.lastReason = evaluateUsageQuota(s.usage, s.quota).reason;
  }
}
