import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StickySelector, BalancedSelector } from '../src/services/key-selectors.js';
import { HealthTracker } from '../src/services/health-tracker.js';
import { ANTI_BAN_DEFAULTS } from '../src/services/anti-ban-config.js';

describe('StickySelector', () => {
  it('keeps active key when present in candidates', () => {
    const tracker = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    const sel = new StickySelector(tracker);
    expect(sel.pick(['a', 'b', 'c'])).toBe('a');
    expect(sel.pick(['a', 'b', 'c'])).toBe('a');
    expect(sel.pick(['a', 'b', 'c'])).toBe('a');
  });

  it('switches to highest score when active not in candidates', () => {
    const tracker = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    tracker.recordError('b');
    tracker.recordError('b');
    const sel = new StickySelector(tracker);
    expect(sel.pick(['a', 'b'])).toBe('a');
    expect(sel.pick(['b', 'c'])).toBe('c');
  });

  it('switches to the previously remembered key when it reappears among candidates', () => {
    const tracker = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    const sel = new StickySelector(tracker);
    expect(sel.pick(['a', 'b'])).toBe('a');
    sel.notifyKeyUnavailable('a');
    expect(sel.pick(['b'])).toBe('b');
    expect(sel.pick(['a', 'b'])).toBe('b');
  });

  it('notifyKeyUnavailable on the active key forces re-evaluation next pick', () => {
    const tracker = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    const sel = new StickySelector(tracker);
    sel.pick(['a', 'b']);
    sel.notifyKeyUnavailable('a');
    expect(['a', 'b']).toContain(sel.pick(['a', 'b']));
  });
});

describe('BalancedSelector', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockRestore();
  });

  it('approximately uniform when scores equal (1000 trials, 2 keys)', () => {
    const tracker = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    const sel = new BalancedSelector(tracker, ANTI_BAN_DEFAULTS.selector.min_weight);
    let aCount = 0;
    for (let i = 0; i < 1000; i++) if (sel.pick(['a', 'b']) === 'a') aCount += 1;
    expect(aCount).toBeGreaterThan(400);
    expect(aCount).toBeLessThan(600);
  });

  it('still picks low-score key occasionally due to min_weight', () => {
    const tracker = new HealthTracker(ANTI_BAN_DEFAULTS.health);
    for (let i = 0; i < 30; i++) tracker.recordRateLimit('b');
    const sel = new BalancedSelector(tracker, 0.05);
    let bCount = 0;
    for (let i = 0; i < 2000; i++) if (sel.pick(['a', 'b']) === 'b') bCount += 1;
    expect(bCount).toBeGreaterThan(0);
  });
});
