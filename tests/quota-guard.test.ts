import { describe, it, expect } from 'vitest';
import { QuotaGuard } from '../src/services/quota-guard.js';

describe('QuotaGuard', () => {
  it('returns ok when no quota configured', () => {
    const g = new QuotaGuard();
    g.setQuota('k1', null);
    g.recordUsage('k1', 1, 100);
    expect(g.isBlocked('k1')).toBe(false);
  });

  it('blocks when requests_used >= max_requests * threshold', () => {
    const g = new QuotaGuard();
    g.setQuota('k1', { max_requests: 100, max_tokens: null, soft_stop_threshold: 0.95 });
    for (let i = 0; i < 95; i++) g.recordUsage('k1', 1, 0);
    expect(g.isBlocked('k1')).toBe(true);
    expect(g.lastBlockReason('k1')).toMatch(/请求/);
  });

  it('blocks when tokens_used >= max_tokens * threshold', () => {
    const g = new QuotaGuard();
    g.setQuota('k1', { max_requests: null, max_tokens: 1000, soft_stop_threshold: 0.9 });
    g.recordUsage('k1', 1, 900);
    expect(g.isBlocked('k1')).toBe(true);
    expect(g.lastBlockReason('k1')).toMatch(/token/);
  });

  it('reset clears usage but preserves quota config', () => {
    const g = new QuotaGuard();
    g.setQuota('k1', { max_requests: 100, max_tokens: null, soft_stop_threshold: 0.95 });
    for (let i = 0; i < 95; i++) g.recordUsage('k1', 1, 0);
    expect(g.isBlocked('k1')).toBe(true);
    g.reset('k1');
    expect(g.isBlocked('k1')).toBe(false);
    expect(g.getUsage('k1')).toEqual({ requests_used: 0, tokens_used: 0 });
  });

  it('hydrate restores prior usage from snapshot', () => {
    const g = new QuotaGuard();
    g.setQuota('k1', { max_requests: 100, max_tokens: null, soft_stop_threshold: 0.95 });
    g.hydrate('k1', { requests_used: 95, tokens_used: 0 });
    expect(g.isBlocked('k1')).toBe(true);
  });

  it('getRatio reports usage as fraction of quota', () => {
    const g = new QuotaGuard();
    g.setQuota('k1', { max_requests: 100, max_tokens: null, soft_stop_threshold: 0.95 });
    for (let i = 0; i < 85; i++) g.recordUsage('k1', 1, 0);
    expect(g.getRatio('k1')).toBeCloseTo(0.85, 5);
  });
});
