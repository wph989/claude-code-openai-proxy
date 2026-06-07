import type { HealthConfig } from '../models.js';

export interface RecentEvents {
  rate_limits: number;
  transients: number;
  successes: number;
}

interface EventList {
  arr: number[];
  head: number;
}

interface KeyHealth {
  rateLimits: EventList;
  transients: EventList;
  successes: EventList;
  consecutiveErrors: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
}

function newList(): EventList {
  return { arr: [], head: 0 };
}

function push(list: EventList, t: number): void {
  list.arr.push(t);
}

function liveCount(list: EventList, cutoff: number): number {
  while (list.head < list.arr.length && list.arr[list.head] < cutoff) list.head++;
  if (list.head > 64 && list.head > list.arr.length / 2) {
    list.arr = list.arr.slice(list.head);
    list.head = 0;
  }
  return list.arr.length - list.head;
}

export class HealthTracker {
  private cfg: Required<HealthConfig>;
  private map = new Map<string, KeyHealth>();

  constructor(cfg: Required<HealthConfig>) {
    this.cfg = cfg;
  }

  recordSuccess(key: string): void {
    const s = this.state(key);
    const now = Date.now();
    push(s.successes, now);
    s.consecutiveErrors = 0;
    s.lastSuccessAt = now;
  }

  recordError(key: string): void {
    const s = this.state(key);
    const now = Date.now();
    push(s.transients, now);
    s.consecutiveErrors += 1;
    s.lastErrorAt = now;
  }

  recordRateLimit(key: string): void {
    const s = this.state(key);
    const now = Date.now();
    push(s.rateLimits, now);
    s.consecutiveErrors += 1;
    s.lastErrorAt = now;
  }

  getScore(key: string): number {
    const s = this.map.get(key);
    if (!s) return 1.0;
    const now = Date.now();
    const cutoff = now - this.cfg.window_ms;

    const c = this.cfg;
    const rlCount = liveCount(s.rateLimits, cutoff);
    const trCount = liveCount(s.transients, cutoff);
    const rl = Math.max(c.rate_limit_penalty_floor, 1.0 - c.rate_limit_penalty_per_event * rlCount);
    const tr = Math.max(c.transient_penalty_floor, 1.0 - c.transient_penalty_per_event * trCount);
    const cn = Math.max(c.consecutive_penalty_floor, 1.0 - c.consecutive_penalty_per_event * Math.max(0, s.consecutiveErrors - 1));
    const fresh = s.lastSuccessAt != null && (now - s.lastSuccessAt) <= c.fresh_success_window_ms ? c.fresh_success_boost : 1.0;
    const raw = rl * tr * cn * fresh;
    return Math.min(c.score_ceiling, Math.max(c.score_floor, raw));
  }

  getRecentEvents(key: string): RecentEvents {
    const s = this.map.get(key);
    if (!s) return { rate_limits: 0, transients: 0, successes: 0 };
    const cutoff = Date.now() - this.cfg.window_ms;
    return {
      rate_limits: liveCount(s.rateLimits, cutoff),
      transients: liveCount(s.transients, cutoff),
      successes: liveCount(s.successes, cutoff)
    };
  }

  private state(key: string): KeyHealth {
    let s = this.map.get(key);
    if (!s) {
      s = { rateLimits: newList(), transients: newList(), successes: newList(), consecutiveErrors: 0, lastSuccessAt: null, lastErrorAt: null };
      this.map.set(key, s);
    }
    return s;
  }
}
