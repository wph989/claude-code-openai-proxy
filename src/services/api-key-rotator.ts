import type { ApiKeyEntry, KeyUsage, KeyQuotaConfig } from '../models.js';
import { KeyRotationStrategy } from '../models.js';
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
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class ApiKeyRotator {
  private _keys: ApiKeyEntry[];
  private _keyIndex: Map<string, number>;
  private _strategy: KeyRotationStrategy;
  private _autoDisable: boolean;
  private _antiBan: ResolvedAntiBan;
  private _providerQuota: KeyQuotaConfig | null;
  private _keyMaxErrors: number;
  private _autoRecoverMs: number;
  private selector: KeySelector;
  private runtime = new Map<string, RuntimeState>();
  private _onChange?: (key: string, patch: KeyStateChange) => void;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private availabilityWaiters = new Set<() => void>();
  private quotaGuard = new QuotaGuard();
  private usageListener: ((key: string, usage: KeyUsage, ratio: number) => void) | null = null;

  constructor(keys: ApiKeyEntry[], strategy: KeyRotationStrategy, autoDisable: boolean = true, antiBan: ResolvedAntiBan, providerQuota: KeyQuotaConfig | null = null, keyMaxErrors: number = 5, autoRecoverMinutes: number = 0) {
    this._keys = keys;
    this._keyIndex = new Map(keys.map((k, i) => [k.key, i]));
    this._strategy = strategy;
    this._autoDisable = autoDisable;
    this._antiBan = antiBan;
    this._providerQuota = providerQuota;
    this._keyMaxErrors = keyMaxErrors;
    this._autoRecoverMs = autoRecoverMinutes > 0 ? autoRecoverMinutes * 60_000 : 0;
    const selectionMode = this.resolveSelectionMode();
    this.selector = selectionMode === 'balanced' ? new BalancedSelector() : new StickySelector();
    for (const k of this._keys) {
      // undefined → 使用供应商配额；null → 显式不使用配额；其他 → 使用 Key 自己的配额
      const effectiveQuota = k.quota !== undefined ? k.quota : this._providerQuota;
      this.quotaGuard.setQuota(k.key, effectiveQuota);
    }
    this.scheduleAutoRecovery();
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
      this.recoverExpiredDisables(now);
      if (this.allUnavailable()) {
        throw new Error('没有可用的 API Key');
      }
      if (options.deadline != null && now >= options.deadline) {
        throw new Error('等待可用 API Key 超时');
      }
      const key = this.pick();
      if (!key) {
        await this.waitForAvailability(now, options.deadline);
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

  private async waitForAvailability(now: number, deadline?: number): Promise<void> {
    const nextAt = this.nextTemporaryAvailableAt(now);
    // 正常情况下由 release / enable 等状态变化主动唤醒；兜底定时器用于冷却到期、lease 泄漏回收和 deadline。
    const fallbackAt = now + 1000;
    const deadlineAt = deadline ?? Number.POSITIVE_INFINITY;
    const wakeAt = Math.max(now + 1, Math.min(nextAt ?? fallbackAt, deadlineAt));
    const waitMs = Math.max(1, wakeAt - now);

    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        this.availabilityWaiters.delete(finish);
        resolve();
      };
      this.availabilityWaiters.add(finish);
      timer = setTimeout(finish, waitMs);
    });
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
      if (state.activeRequests >= this._antiBan.max_concurrent && state.activeLeaseStarts.length > 0) {
        // 即使调用方遗漏 release，也要在最老 lease 到期时醒来执行 sweepLeakedLeases。
        nextAt = minNullable(nextAt, state.activeLeaseStarts[0] + LEASE_MAX_AGE_MS);
      }
    }
    return nextAt;
  }

  private signalAvailabilityChange(): void {
    if (this.availabilityWaiters.size === 0) return;
    // 状态变化可能让多个并发名额或不同 Key 同时可用，统一唤醒后由 pick 重新竞争最可靠。
    for (const wake of Array.from(this.availabilityWaiters)) wake();
  }

  release(lease: KeyLease | string | undefined): void {
    const key = typeof lease === 'string' ? lease : lease?.key;
    if (!key) return;
    const state = this.getRuntimeState(key);
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    if (state.activeLeaseStarts.length > 0) {
      state.activeLeaseStarts.shift();
    }
    this.signalAvailabilityChange();
  }

  // error_count 累计到阈值时把禁用状态写进 patch。markError / markRateLimited 共用，
  // 保证「累计够阈值就自动禁用」这条规则在所有错误类别上一致。
  private applyAutoDisable(entry: ApiKeyEntry, patch: KeyStateChange, now: number): void {
    if (this._autoDisable && entry.error_count + 1 >= this._keyMaxErrors && entry.enabled) {
      patch.enabled = false;
      patch.auto_disabled_at = now;
    }
  }

  // 自动恢复只碰带 auto_disabled_at 的 Key；手动禁用会清掉该标记，因此不会被定时任务误恢复。
  // acquire 和状态查询仍会补做一次到期检查，避免事件循环繁忙导致定时器延迟时返回过期状态。
  private recoverExpiredDisables(now: number): void {
    if (this._autoRecoverMs <= 0) return;
    for (const entry of this._keys) {
      if (entry.enabled) continue;
      if (entry.auto_disabled_at == null) continue;
      if (now - entry.auto_disabled_at < this._autoRecoverMs) continue;
      this.enableKey(entry.key);
    }
  }

  private scheduleAutoRecovery(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    if (this._autoRecoverMs <= 0) return;

    let nextRecoveryAt: number | null = null;
    for (const entry of this._keys) {
      if (entry.enabled || entry.auto_disabled_at == null) continue;
      const recoveryAt = entry.auto_disabled_at + this._autoRecoverMs;
      nextRecoveryAt = nextRecoveryAt == null ? recoveryAt : Math.min(nextRecoveryAt, recoveryAt);
    }
    if (nextRecoveryAt == null) return;

    // Node 的 setTimeout 最长约 24.8 天；更长的恢复窗口分段唤醒，避免溢出后立即执行。
    const delay = Math.min(Math.max(0, nextRecoveryAt - Date.now()), MAX_TIMER_DELAY_MS);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.recoverExpiredDisables(Date.now());
      this.scheduleAutoRecovery();
    }, delay);
    // 自动恢复定时器不应单独阻止服务正常退出。
    this.recoveryTimer.unref?.();
  }

  markError(key: string, errorMessage: string, category: KeyErrorCategory = 'transient'): void {
    const entry = this.entryFor(key);
    if (!entry) return;

    const patch: KeyStateChange = {
      error_count: entry.error_count + 1,
      last_error_at: Date.now(),
      last_error_message: errorMessage
    };

    this.applyAutoDisable(entry, patch, Date.now());
    this.getRuntimeState(key).lastErrorCategory = category;

    Object.assign(entry, patch);
    this._onChange?.(key, patch);
    if (patch.auto_disabled_at != null) this.scheduleAutoRecovery();
    // transient/network 说明当前 key 或链路刚失败过，sticky 模式继续咬住它会放大中断概率。
    this.selector.notifyKeyUnavailable(key);
    this.signalAvailabilityChange();
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
    this.scheduleAutoRecovery();
    this.selector.notifyKeyUnavailable(key);
    this.signalAvailabilityChange();
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
    // 429 累计到阈值同样自动禁用：反复限流的 key 长期占着冷却位，不如禁用交给人工/恢复流程处理。
    this.applyAutoDisable(entry, patch, now);
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
    if (patch.auto_disabled_at != null) this.scheduleAutoRecovery();
    if (this._antiBan.sticky_on_cooldown === 'fallthrough') {
      this.selector.notifyKeyUnavailable(key);
    }
    this.signalAvailabilityChange();
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
    this.signalAvailabilityChange();
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
    this.signalAvailabilityChange();
  }

  setKeyQuota(key: string, quota: KeyQuotaConfig | null | undefined): void {
    const entry = this.entryFor(key);
    if (!entry) return;
    entry.quota = quota;
    // undefined → 使用供应商配额；null → 显式不使用配额；其他 → 使用 Key 自己的配额
    const effectiveQuota = quota !== undefined ? quota : this._providerQuota;
    this.quotaGuard.setQuota(key, effectiveQuota);
    this.notifyUsage(key);
    this.signalAvailabilityChange();
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
    this.recoverExpiredDisables(Date.now());
    if (this._keys.length === 0) return true;
    // 只统计「永久不可用」（禁用 / 配额阻塞）：冷却中属于临时状态，acquire 会等到期后重试，
    // 不能算作彻底没 key，否则 acquire 会在冷却窗口内直接抛错而非等待。
    return this._keys.every((entry) => {
      if (!entry.enabled) return true;
      if (this.quotaGuard.isBlocked(entry.key)) return true;
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
    this.scheduleAutoRecovery();
    this.signalAvailabilityChange();
  }

  disableKey(key: string, reason?: string): void {
    const entry = this.entryFor(key);
    if (!entry) return;
    const patch: KeyStateChange = {
      enabled: false,
      disabled_at: Date.now(),
      // 用户主动禁用后必须取消自动恢复资格，否则旧的自动禁用时间会把它再次启用。
      auto_disabled_at: null
    };
    if (reason) {
      patch.last_error_at = Date.now();
      patch.last_error_message = reason;
      this.getRuntimeState(key).lastErrorCategory = 'hard_limit';
    }
    Object.assign(entry, patch);
    this._onChange?.(key, patch);
    this.scheduleAutoRecovery();
    this.signalAvailabilityChange();
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
    this.scheduleAutoRecovery();
    this.signalAvailabilityChange();
  }

  getKeys(): ApiKeyEntry[] {
    return this._keys;
  }

  getKeyStatuses(): KeyRuntimeStatus[] {
    const now = Date.now();
    this.recoverExpiredDisables(now);
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

  dispose(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    // 热更新只停止旧实例的后台写入；已持有该实例的在途请求仍需完成等待、重试和 lease 释放。
    this._onChange = undefined;
    this.usageListener = null;
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
