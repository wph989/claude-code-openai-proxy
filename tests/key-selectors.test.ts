import { describe, it, expect } from 'vitest';
import { StickySelector, BalancedSelector } from '../src/services/key-selectors.js';

describe('StickySelector', () => {
  it('keeps active key when present in candidates', () => {
    const sel = new StickySelector();
    expect(sel.pick(['a', 'b', 'c'])).toBe('a');
    expect(sel.pick(['a', 'b', 'c'])).toBe('a');
    expect(sel.pick(['a', 'b', 'c'])).toBe('a');
  });

  it('picks the first candidate when active key disappears', () => {
    const sel = new StickySelector();
    expect(sel.pick(['a', 'b'])).toBe('a');
    expect(sel.pick(['b', 'c'])).toBe('b');
  });

  it('avoids the failed key on the next pick when other candidates exist', () => {
    const sel = new StickySelector();
    expect(sel.pick(['a', 'b'])).toBe('a');
    sel.notifyKeyUnavailable('a');
    expect(sel.pick(['a', 'b'])).toBe('b');
  });

  it('falls back to the failed key when it is the only candidate', () => {
    const sel = new StickySelector();
    expect(sel.pick(['a'])).toBe('a');
    sel.notifyKeyUnavailable('a');
    expect(sel.pick(['a'])).toBe('a');
  });

  it('avoid marker is one-shot: sticks to the new key afterwards', () => {
    const sel = new StickySelector();
    sel.pick(['a', 'b']);
    sel.notifyKeyUnavailable('a');
    expect(sel.pick(['a', 'b'])).toBe('b');
    // 再次 pick 不应因为旧的规避标记而反复切换
    expect(sel.pick(['a', 'b'])).toBe('b');
  });

  it('currentKey reflects the last picked key', () => {
    const sel = new StickySelector();
    expect(sel.currentKey()).toBeUndefined();
    sel.pick(['a', 'b']);
    expect(sel.currentKey()).toBe('a');
  });
});

describe('BalancedSelector', () => {
  it('returns undefined for empty candidates', () => {
    const sel = new BalancedSelector();
    expect(sel.pick([])).toBeUndefined();
  });

  it('spreads picks across all candidates', () => {
    const sel = new BalancedSelector();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const k = sel.pick(['a', 'b', 'c']);
      if (k) seen.add(k);
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it('currentKey is always undefined (stateless)', () => {
    const sel = new BalancedSelector();
    sel.pick(['a', 'b']);
    expect(sel.currentKey()).toBeUndefined();
  });
});
