import type { ApiKeyEntry, KeyUsage, KeyQuotaConfig } from '../models.js';
import { KeyRotationStrategy } from '../models.js';
import { settings } from '../config.js';
import { StickySelector, BalancedSelector, type KeySelector } from './key-selectors.js';
import type { ResolvedAntiBan } from './anti-ban-config.js';
import { QuotaGuard } from './quota-guard.js';

export type KeyErrorCategory = 'hard_limit' | 'rate_limit' | 'transient' | 'network' | null;

export type KeyLease = {
  key: string;
};

export type AcquireOptions = {
  deadline?: number;
};

export type KeyRuntimeStatus = ApiKeyEntry & {
  status: 'available' | 'delayed' | 'disabled' | 'busy';
  active_requests: number;
  next_available_at: number | null;
  last_error_category: KeyErrorCategory;
  disabled_reason: string | null;
  usage?: KeyUsage;
  quota?: KeyQuotaConfig | null;
  quota_blocked?: boolean;
  quota_reason?: string | null;
};

export type KeyStateChange = {
  enabled?: boolean;
  error_count?: number;
  disabled_at?: number | null;
  last_error_at?: number | null;
  last_error_message?: string | null;
  auto_disabled_at?: number | null;
  note?: string;
};

interface RuntimeState {
  activeRequests: number;
  activeLeaseStarts: number[]; // 每个进行中 lease 的开始时间，用于清理泄漏的 lease
  nextAvailableAt: number | null;
  lastSentAt: number | null;
  lastErrorCategory: KeyErrorCategory;
}

// 单个 lease 最长存活时间：超过此值认为是 release 调用泄漏，强制释放。
// 默认 10 分钟，覆盖最长正常流式请求；设过短会误杀慢请求，设过长会让泄漏 lease 卡住更久。
const LEASE_MAX_AGE_MS = 10 * 60 * 1000;

export class ApiKeyRotator {
  private _keys: ApiKeyEntry[];
  private _keyIndex: Map<string, number>;
  private _strategy: KeyRotationStrategy;
  private _autoDisable: boolean;
  private _antiBan: ResolvedAntiBan;
  private _providerQuota: KeyQuotaConfig | null;
  private selector: KeySelector;
  private runtime = new Map<string, RuntimeState>();
  private _onChange?: (key: string, patch: KeyStateChange) => void;
  private quotaGuard = new QuotaGuard();
  private usageListener: ((key: string, usage: KeyUsage, ratio: number) => void) | null = null;

  constructor(keys: ApiKeyEntry[], strategy: KeyRotationStrategy, autoDisable: boolean = true, antiBan: ResolvedAntiBan, providerQuota: KeyQuotaConfig | null = null) {
    this._keys = keys;
    this._keyIndex = new Map(keys.map((k, i) => [k.key, i]));
    this._strategy = strategy;
    this._autoDisable = autoDisable;
    this._antiBan = antiBan;
    this._providerQuota = providerQuota;
    const selectionMode = this.resolveSelectionMode();
    this.selector = selectionMode === 'balanced' ? new BalancedSelector() : new StickySelector();
    for (const k of this._keys) {
      // undefined → 使用供应商配额；null → 显式不使用配额；其他 → 使用 Key 自己的配额
      const effectiveQuota = k.quota !== undefined ? k.quota : this._providerQuota;
      this.quotaGuard.setQuota(k.key, effectiveQuota);
    }
  }

  private resolveSelectionMode(): 'sticky' | 'balanced' {
    if (this._antiBan.key_selection === 'balanced') return 'balanced';
    if (this._antiBan.key_selection === 'sticky') return 'sticky';
    return this._strategy === KeyRotationStrategy.round_robin ? 'balanced' : 'sticky';
  }

  set onChange(fn: ((key: string, patch: KeyStateChange) => void) | undefined) {
    this._onChange = fn;
  }

  get keys(): ApiKeyEntry[] {
    return this._keys;
  }

  get keyCount(): number {
    return this._keys.length;
  }

  get strategy(): KeyRotationStrategy {
    return this._strategy;
  }

  get antiBan(): ResolvedAntiBan {
    return this._antiBan;
  }

  pick(): string | undefined {
    if (this._keys.length === 0) return undefined;
    const candidates = this.eligibleKeys();
    if (candidates.length === 0) return undefined;
    return this.selector.pick(candidates);
  }

  private eligibleKeys(): string[] {
    const now = Date.now();
    if (this.shouldWaitForStickyCooldown(now)) {
      return [];
    }
    const result: string[] = [];
    for (const entry of this._keys) {
      if (!entry.enabled) continue;
      if (this.quotaGuard.isBlocked(entry.key)) continue;
      const state = this.getRuntimeState(entry.key);
      this.sweepLeakedLeases(state, now);
      if (state.activeRequests >= this._antiBan.max_concurrent) continue;
      if (state.nextAvailableAt != null && state.nextAvailableAt > now) continue;
      if (state.lastSentAt != null && (state.lastSentAt + this._antiBan.min_interval_ms) > now) continue;
      result.push(entry.key);
    }
    return result;
  }

  private shouldWaitForStickyCooldown(now: number): boolean {
    if (this._antiBan.sticky_on_cooldown !== 'wait') return false;
    const activeKey = this.selector.currentKey();
    if (!activeKey) return false;
    const entry = this.entryFor(activeKey);
    if (!entry?.enabled) return false;
    if (this.quotaGuard.isBlocked(activeKey)) return false;
    const state = this.getRuntimeState(activeKey);
    // wait 模式只针对 429 冷却：其他不可用原因（禁用/配额）仍允许重新选择。
    return state.nextAvailableAt != null && state.nextAvailableAt > now;
  }

  async acquire(options: AcquireOptions = {}): Promise<KeyLease> {
    while (true) {
      const now = Date.now();
      if (this.allUnavailable()) {
        throw new Error('没有可用的 API Key');
      }
      if (options.deadline != null && now >= options.deadline) {
        throw new Error('等待可用 API Key 超时');
      }
      const key = this.pick();
      if (!key) {
        await sleep(this.nextAcquireSleepMs(now, options.deadline));
        continue;
      }
      const state = this.getRuntimeState(key);
      state.activeRequests++;
      state.activeLeaseStarts.push(now);
      state.lastSentAt = now;
      if (state.nextAvailableAt != null && state.nextAvailableAt <= now) {
        state.nextAvailableAt = null;
      }
      return { key };
    }
  }

  private nextAcquireSleepMs(now: number, deadline?: number): number {
    const nextAt = this.nextTemporaryAvailableAt(now);
    const fallback = now + 5;
    const wakeAt = Math.max(now + 1, Math.min(nextAt ?? fallback, fallback));
    if (deadline == null) return wakeAt - now;
    return Math.max(1, Math.min(wakeAt, deadline) - now);
  }

  private nextTemporaryAvailableAt(now: number): number | null {
    let nextAt: number | null = null;
    for (const entry of this._keys) {
      if (!entry.enabled) continue;
      if (this.quotaGuard.isBlocked(entry.key)) continue;
      const state = this.getRuntimeState(entry.key);
      this.sweepLeakedLeases(state, now);
      if (state.nextAvailableAt != null && state.nextAvailableAt > now) {
        nextAt = minNullable(nextAt, state.nextAvailableAt);
      }
      if (state.lastSentAt != null && (state.lastSentAt + this._antiBan.min_interval_ms) > now) {
        nextAt = minNullable(nextAt, state.lastSentAt + this._antiBan.min_interval_ms);
      }
    }
    return nextAt;
  }

  release(lease: KeyLease | string | undefined): void {
    const key = typeof lease === 'string' ? lease : lease?.key;
    if (!key) return;
    const state = this.getRuntimeState(key);
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    if (state.activeLeaseStarts.length > 0) {
      state.activeLeaseStarts.shift();
    }
  }

  markError(key: string, errorMessage: string, category: KeyErrorCategory = 'transient'): void {
    const entry = this.entryFor(key);
    if (!entry) return;

    const patch: KeyStateChange = {
      error_count: entry.error_count + 1,
      last_error_at: Date.now(),
      last_error_message: errorMessage
    };

    if (settings.keyAutoDisable && this._autoDisable && entry.error_count + 1 >= settings.keyMaxErrors && entry.enabled) {
      patch.enabled = false;
      patch.auto_disabled_at = Date.now();
    }
    this.getRuntimeState(key).lastErrorCategory = category;

    Object.assign(entry, patch);
    this._onChange?.(key, patch);
    // transient/network 说明当前 key 或链路刚失败过，sticky 模式继续咬住它会放大中断概率。
    this.selector.notifyKeyUnavailable(key);
  }

  markQuotaError(key: string, errorMessage: string): void {
    const entry = this.entryFor(key);
    if (!entry) return;

    const now = Date.now();
    const patch: KeyStateChange = {
      enabled: false,
      error_count: entry.error_count + 1,
      last_error_at: now,
      last_error_message: errorMessage,
      auto_disabled_at: now
    };
    this.getRuntimeState(key).lastErrorCategory = 'hard_limit';
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
    this.selector.notifyKeyUnavailable(key);
  }

  markRateLimited(key: string, errorMessage: string): void {
    const entry = this.entryFor(key);
    if (!entry) return;

    const now = Date.now();
    const state = this.getRuntimeState(key);
    // 冷却期内重复 429 不续命：只在已到期（或首次）时重新设定 nextAvailableAt，
    // 否则连续重试可以把冷却结束时间无限推后，肉眼看就是「永远不恢复」。
    if (state.nextAvailableAt == null || state.nextAvailableAt <= now) {
      const delay = randomBetween(this._antiBan.rate_limit_delay_min_ms, this._antiBan.rate_limit_delay_max_ms);
      state.nextAvailableAt = now + delay;
    }
    state.lastErrorCategory = 'rate_limit';
    const patch: KeyStateChange = {
      error_count: entry.error_count + 1,
      last_error_at: now,
      last_error_message: errorMessage
    };
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
    if (this._antiBan.sticky_on_cooldown === 'fallthrough') {
      this.selector.notifyKeyUnavailable(key);
    }
  }

  markSuccess(key: string): void {
    const entry = this.entryFor(key);
    if (!entry) return;
    if (entry.error_count === 0 && entry.last_error_at === null) return;
    const patch: KeyStateChange = {
      error_count: 0,
      last_error_at: null,
      last_error_message: null
    };
    this.getRuntimeState(key).lastErrorCategory = null;
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  recordUsage(key: string, requests: number, tokens: number): void {
    this.quotaGuard.recordUsage(key, requests, tokens);
    this.notifyUsage(key);
  }

  setUsageListener(fn: ((key: string, usage: KeyUsage, ratio: number) => void) | null): void {
    this.usageListener = fn;
  }

  hydrateUsage(key: string, usage: KeyUsage): void {
    this.quotaGuard.hydrate(key, usage);
  }

  resetUsage(key: string): void {
    this.quotaGuard.reset(key);
    this.notifyUsage(key);
  }

  setKeyQuota(key: string, quota: KeyQuotaConfig | null | undefined): void {
    const entry = this.entryFor(key);
    if (!entry) return;
    entry.quota = quota;
    // undefined → 使用供应商配额；null → 显式不使用配额；其他 → 使用 Key 自己的配额
    const effectiveQuota = quota !== undefined ? quota : this._providerQuota;
    this.quotaGuard.setQuota(key, effectiveQuota);
    this.notifyUsage(key);
  }

  private notifyUsage(key: string): void {
    if (!this.usageListener) return;
    this.usageListener(key, this.quotaGuard.getUsage(key), this.quotaGuard.getRatio(key));
  }

  getQuotaSnapshot(key: string): { usage: KeyUsage; quota: KeyQuotaConfig | null; blocked: boolean; reason: string | null } {
    return {
      usage: this.quotaGuard.getUsage(key),
      quota: this.quotaGuard.getQuota(key),
      blocked: this.quotaGuard.isBlocked(key),
      reason: this.quotaGuard.lastBlockReason(key)
    };
  }

  allUnavailable(): boolean {
    if (this._keys.length === 0) return true;
    const now = Date.now();
    // 检查所有 Key 是否都不可用（禁用、配额阻塞、或冷却中）
    return this._keys.every((entry) => {
      if (!entry.enabled) return true;
      if (this.quotaGuard.isBlocked(entry.key)) return true;
      const state = this.getRuntimeState(entry.key);
      // 冷却中也算不可用
      if (state.nextAvailableAt != null && state.nextAvailableAt > now) return true;
      return false;
    });
  }

  hasAvailableKey(): boolean {
    return !this.allUnavailable();
  }

  enableKey(key: string): void {
    const entry = this.entryFor(key);
    if (!entry) return;
    const patch: KeyStateChange = {
      enabled: true,
      error_count: 0,
      disabled_at: null,
      auto_disabled_at: null
    };
    const state = this.getRuntimeState(key);
    state.nextAvailableAt = null;
    state.lastErrorCategory = null;
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  disableKey(key: string, reason?: string): void {
    const entry = this.entryFor(key);
    if (!entry) return;
    const patch: KeyStateChange = {
      enabled: false,
      disabled_at: Date.now()
    };
    if (reason) {
      patch.last_error_at = Date.now();
      patch.last_error_message = reason;
      this.getRuntimeState(key).lastErrorCategory = 'hard_limit';
    }
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  resetErrorCount(key: string): void {
    const entry = this.entryFor(key);
    if (!entry) return;
    const patch: KeyStateChange = {
      error_count: 0,
      enabled: true,
      disabled_at: null,
      auto_disabled_at: null,
      last_error_at: null,
      last_error_message: null
    };
    const state = this.getRuntimeState(key);
    state.nextAvailableAt = null;
    state.lastErrorCategory = null;
    state.activeRequests = 0;
    state.activeLeaseStarts = [];
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
  }

  getKeys(): ApiKeyEntry[] {
    return this._keys;
  }

  getKeyStatuses(): KeyRuntimeStatus[] {
    const now = Date.now();
    return this._keys.map((entry) => {
      const state = this.getRuntimeState(entry.key);
      const delayed = entry.enabled && state.nextAvailableAt != null && state.nextAvailableAt > now;
      const busy = entry.enabled && !delayed && state.activeRequests >= this._antiBan.max_concurrent;
      const snap = this.getQuotaSnapshot(entry.key);
      return {
        ...entry,
        status: !entry.enabled ? 'disabled' : delayed ? 'delayed' : busy ? 'busy' : 'available',
        active_requests: state.activeRequests,
        next_available_at: delayed ? state.nextAvailableAt : null,
        last_error_category: state.lastErrorCategory,
        disabled_reason: !entry.enabled ? entry.last_error_message || null : null,
        usage: snap.usage,
        quota: snap.quota,
        quota_blocked: snap.blocked,
        quota_reason: snap.reason
      };
    });
  }

  private entryFor(key: string): ApiKeyEntry | undefined {
    const idx = this._keyIndex.get(key);
    return idx === undefined ? undefined : this._keys[idx];
  }

  private getRuntimeState(key: string): RuntimeState {
    let state = this.runtime.get(key);
    if (!state) {
      state = {
        activeRequests: 0,
        activeLeaseStarts: [],
        nextAvailableAt: null,
        lastSentAt: null,
        lastErrorCategory: null
      };
      this.runtime.set(key, state);
    }
    return state;
  }

  /**
   * 清理已超期未 release 的 lease：把僵尸 activeRequests 减回去，避免 key 永远被「占满」卡住。
   */
  private sweepLeakedLeases(state: RuntimeState, now: number): void {
    if (state.activeLeaseStarts.length === 0) return;
    const cutoff = now - LEASE_MAX_AGE_MS;
    let removed = 0;
    while (state.activeLeaseStarts.length > 0 && state.activeLeaseStarts[0] < cutoff) {
      state.activeLeaseStarts.shift();
      removed++;
    }
    if (removed > 0) {
      state.activeRequests = Math.max(0, state.activeRequests - removed);
    }
  }
}

function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function minNullable(a: number | null, b: number): number {
  return a == null ? b : Math.min(a, b);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
