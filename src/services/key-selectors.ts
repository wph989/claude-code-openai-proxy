import type { HealthTracker } from './health-tracker.js';

export interface KeySelector {
  pick(candidates: string[]): string | undefined;
  notifyKeyUnavailable(key: string): void;
  currentKey(): string | undefined;
}

export class StickySelector implements KeySelector {
  private tracker: HealthTracker;
  private activeKey: string | undefined = undefined;

  constructor(tracker: HealthTracker) {
    this.tracker = tracker;
  }

  pick(candidates: string[]): string | undefined {
    if (candidates.length === 0) return undefined;
    if (this.activeKey && candidates.includes(this.activeKey)) {
      return this.activeKey;
    }
    const best = this.bestByScore(candidates);
    this.activeKey = best;
    return best;
  }

  notifyKeyUnavailable(key: string): void {
    if (this.activeKey === key) {
      this.activeKey = undefined;
    }
  }

  currentKey(): string | undefined {
    return this.activeKey;
  }

  private bestByScore(candidates: string[]): string {
    let best = candidates[0];
    let bestScore = this.tracker.getScore(best);
    for (let i = 1; i < candidates.length; i++) {
      const s = this.tracker.getScore(candidates[i]);
      if (s > bestScore) {
        best = candidates[i];
        bestScore = s;
      }
    }
    return best;
  }
}

export class BalancedSelector implements KeySelector {
  private tracker: HealthTracker;
  private minWeight: number;

  constructor(tracker: HealthTracker, minWeight: number) {
    this.tracker = tracker;
    this.minWeight = minWeight;
  }

  pick(candidates: string[]): string | undefined {
    if (candidates.length === 0) return undefined;
    const weights = candidates.map((k) => Math.max(this.minWeight, this.tracker.getScore(k)));
    const total = weights.reduce((acc, w) => acc + w, 0);
    let r = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }

  notifyKeyUnavailable(_key: string): void {
    // BalancedSelector 无内部状态需要清理
  }

  currentKey(): string | undefined {
    return undefined;
  }
}
