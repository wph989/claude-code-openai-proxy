import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HealthTracker } from '../src/services/health-tracker.js';
import { ANTI_BAN_DEFAULTS } from '../src/services/anti-ban-config.js';

describe('HealthTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-06T00:00:00Z'));
  });

  it('empty state returns score = 1.0', () => {
    const t = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    expect(t.getScore('k1')).toBe(1.0);
  });

  it('one rate limit drops score by per_event', () => {
    const t = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    t.recordRateLimit('k1');
    expect(t.getScore('k1')).toBeCloseTo(1.0 - 0.15, 5);
  });

  it('many rate limits never below floor', () => {
    const t = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    for (let i = 0; i < 50; i++) t.recordRateLimit('k1');
    expect(t.getScore('k1')).toBeGreaterThanOrEqual(ANTI_BAN_DEFAULTS.health.rate_limit_penalty_floor * ANTI_BAN_DEFAULTS.health.consecutive_penalty_floor * ANTI_BAN_DEFAULTS.health.score_floor);
    expect(t.getScore('k1')).toBeGreaterThanOrEqual(ANTI_BAN_DEFAULTS.health.score_floor);
  });

  it('events expire after window_ms', () => {
    const t = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    t.recordRateLimit('k1');
    expect(t.getScore('k1')).toBeLessThan(1.0);
    vi.advanceTimersByTime(ANTI_BAN_DEFAULTS.health.window_ms + 1000);
    t.recordSuccess('k1');
    expect(t.getScore('k1')).toBeGreaterThanOrEqual(1.0);
  });

  it('success clears consecutive errors', () => {
    const t = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    t.recordError('k1');
    t.recordError('k1');
    t.recordError('k1');
    const beforeRecover = t.getScore('k1');
    t.recordSuccess('k1');
    const afterRecover = t.getScore('k1');
    expect(afterRecover).toBeGreaterThan(beforeRecover);
  });

  it('fresh success boost applies within window', () => {
    const t = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    t.recordSuccess('k1');
    expect(t.getScore('k1')).toBeCloseTo(ANTI_BAN_DEFAULTS.health.fresh_success_boost, 5);
  });

  it('records summary by category for admin', () => {
    const t = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    t.recordRateLimit('k1');
    t.recordError('k1');
    t.recordSuccess('k1');
    const ev = t.getRecentEvents('k1');
    expect(ev.rate_limits).toBe(1);
    expect(ev.transients).toBe(1);
    expect(ev.successes).toBe(1);
  });
});
