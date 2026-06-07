import type { KeyQuotaConfig, KeyUsage } from '../models.js';

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
    s.usage = { ...usage };
    this.evaluate(key);
  }

  recordUsage(key: string, requests: number, tokens: number): void {
    const s = this.ensure(key);
    s.usage.requests_used += requests;
    s.usage.tokens_used += tokens;
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
    return s ? this.ratio(s) : 0;
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
    s.usage = { requests_used: 0, tokens_used: 0 };
    s.lastReason = null;
  }

  private ensure(key: string): State {
    let s = this.states.get(key);
    if (!s) {
      s = { usage: { requests_used: 0, tokens_used: 0 }, quota: null, lastReason: null };
      this.states.set(key, s);
    }
    return s;
  }

  private ratio(s: State): number {
    if (!s.quota) return 0;
    const reqRatio = s.quota.max_requests != null && s.quota.max_requests > 0
      ? s.usage.requests_used / s.quota.max_requests : 0;
    const tokRatio = s.quota.max_tokens != null && s.quota.max_tokens > 0
      ? s.usage.tokens_used / s.quota.max_tokens : 0;
    return Math.max(reqRatio, tokRatio);
  }

  private evaluate(key: string): void {
    const s = this.ensure(key);
    if (!s.quota) { s.lastReason = null; return; }
    const t = s.quota.soft_stop_threshold ?? 0.95;
    if (s.quota.max_requests != null && s.usage.requests_used >= s.quota.max_requests * t) {
      s.lastReason = '本地请求配额接近上限';
      return;
    }
    if (s.quota.max_tokens != null && s.usage.tokens_used >= s.quota.max_tokens * t) {
      s.lastReason = '本地 token 配额接近上限';
      return;
    }
    s.lastReason = null;
  }
}
