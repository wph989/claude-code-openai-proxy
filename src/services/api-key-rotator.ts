import type { ApiKeyEntry, KeyUsage, KeyQuotaConfig } from '../models.js';
import { KeyRotationStrategy } from '../models.js';
import { StickySelector, BalancedSelector, type KeySelector } from './key-selectors.js';
import type { ResolvedAntiBan } from './anti-ban-config.js';
import { QuotaGuard } from './quota-guard.js';
import { KeyAutoRecoveryScheduler } from './key-auto-recovery.js';
import type {
  KeyRuntimeCoordinator,
  SharedKeyCandidate,
  SharedKeySnapshot,
} from './key-runtime-coordinator.js';
import type { KeyUsageDelta } from './usage-budget.js';

export type KeyErrorCategory = 'hard_limit' | 'rate_limit' | 'transient' | 'network' | null;

export type KeyLease = {
  key: string;
  /** SQLite 共享运行态使用稳定 lease ID，release 可跨 Worker 幂等执行。 */
  sharedLeaseId?: string;
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

export interface SharedKeyRuntimeOptions {
  coordinator: KeyRuntimeCoordinator;
  providerId: string;
  /** 测试可缩短 TTL；生产默认值与本地泄漏回收窗口一致。 */
  leaseTtlMs?: number;
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
  private _keyMaxErrors: number;
  private _autoRecoverMs: number;
  private autoRecovery: KeyAutoRecoveryScheduler;
  private selector: KeySelector;
  private runtime = new Map<string, RuntimeState>();
  private _onChange?: (key: string, patch: KeyStateChange) => void;
  private availabilityWaiters = new Set<() => void>();
  private quotaGuard = new QuotaGuard();
  private usageListener: ((key: string, usage: KeyUsage, ratio: number) => void) | null = null;
  private readonly sharedRuntime: SharedKeyRuntimeOptions | null;
  private readonly sharedLeaseTtlMs: number;

  constructor(keys: ApiKeyEntry[], strategy: KeyRotationStrategy, autoDisable: boolean = true, antiBan: ResolvedAntiBan, providerQuota: KeyQuotaConfig | null = null, keyMaxErrors: number = 5, autoRecoverMinutes: number = 0, sharedRuntime: SharedKeyRuntimeOptions | null = null) {
    this._keys = keys;
    this._keyIndex = new Map(keys.map((k, i) => [k.key, i]));
    this._strategy = strategy;
    this._autoDisable = autoDisable;
    this._antiBan = antiBan;
    this._providerQuota = providerQuota;
    this._keyMaxErrors = keyMaxErrors;
    this._autoRecoverMs = autoRecoverMinutes > 0 ? autoRecoverMinutes * 60_000 : 0;
    this.sharedRuntime = sharedRuntime;
    this.sharedLeaseTtlMs = normalizeLeaseTtl(sharedRuntime?.leaseTtlMs);
    const selectionMode = this.resolveSelectionMode();
    this.selector = selectionMode === 'balanced' ? new BalancedSelector() : new StickySelector();
    for (const k of this._keys) {
      // undefined → 使用供应商配额；null → 显式不使用配额；其他 → 使用 Key 自己的配额
      const effectiveQuota = k.quota !== undefined ? k.quota : this._providerQuota;
      this.quotaGuard.setQuota(k.key, effectiveQuota);
    }
    // 共享模式由事务访问顺带恢复，避免每个 Worker 都启动一份相同的恢复定时器。
    const localAutoRecoverMs = sharedRuntime ? 0 : this._autoRecoverMs;
    this.autoRecovery = new KeyAutoRecoveryScheduler(this._keys, localAutoRecoverMs, (key) => this.enableKey(key));
    this.autoRecovery.schedule();
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
    if (this.sharedRuntime) return this.acquireShared(options);
    while (true) {
      const now = Date.now();
      this.autoRecovery.recoverExpired(now);
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

  private async acquireShared(options: AcquireOptions): Promise<KeyLease> {
    while (true) {
      const now = Date.now();
      if (options.deadline != null && now >= options.deadline) {
        throw new Error('等待可用 API Key 超时');
      }
      const result = this.sharedRuntime!.coordinator.tryAcquire(
        this.orderedSharedCandidates(),
        now,
        this.sharedLeaseTtlMs,
      );
      if (result.lease) {
        const entry = this.entryForCompositeKey(result.lease.compositeKey);
        if (!entry) {
          // 配置热更新与 acquire 交错时不能遗留数据库 lease。
          this.sharedRuntime!.coordinator.release(result.lease.leaseId);
          throw new Error('已获取的 API Key 不再存在于当前配置');
        }
        if (result.snapshot) this.applySharedSnapshot(entry, result.snapshot, true, false);
        return { key: entry.key, sharedLeaseId: result.lease.leaseId };
      }
      if (!result.hasPotentialCandidate) throw new Error('没有可用的 API Key');
      await this.waitForAvailability(now, options.deadline, result.nextAvailableAt);
    }
  }

  private async waitForAvailability(now: number, deadline?: number, sharedNextAt?: number | null): Promise<void> {
    const nextAt = sharedNextAt ?? this.nextTemporaryAvailableAt(now);
    // 正常情况下由 release / enable 等状态变化主动唤醒；兜底定时器用于冷却到期、lease 泄漏回收和 deadline。
    // 其他 Worker release 无法触发本进程 waiter；共享模式短轮询保证名额及时可见。
    const fallbackAt = now + (this.sharedRuntime ? 100 : 1000);
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
    if (typeof lease !== 'string' && lease?.sharedLeaseId && this.sharedRuntime) {
      this.sharedRuntime.coordinator.release(lease.sharedLeaseId);
      this.signalAvailabilityChange();
      return;
    }
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

  markError(key: string, errorMessage: string, category: KeyErrorCategory = 'transient'): void {
    const entry = this.entryFor(key);
    if (!entry) return;

    if (this.sharedRuntime) {
      const snapshot = this.sharedRuntime.coordinator.markError(this.sharedCandidate(entry), {
        now: Date.now(),
        message: errorMessage,
        category: category ?? 'transient',
        autoDisable: this._autoDisable,
        maxErrors: this._keyMaxErrors,
      });
      this.applySharedSnapshot(entry, snapshot, true, false);
      this.selector.notifyKeyUnavailable(key);
      this.signalAvailabilityChange();
      return;
    }

    const patch: KeyStateChange = {
      error_count: entry.error_count + 1,
      last_error_at: Date.now(),
      last_error_message: errorMessage
    };

    this.applyAutoDisable(entry, patch, Date.now());
    this.getRuntimeState(key).lastErrorCategory = category;

    Object.assign(entry, patch);
    this._onChange?.(key, patch);
    if (patch.auto_disabled_at != null) this.autoRecovery.schedule();
    // transient/network 说明当前 key 或链路刚失败过，sticky 模式继续咬住它会放大中断概率。
    this.selector.notifyKeyUnavailable(key);
    this.signalAvailabilityChange();
  }

  markQuotaError(key: string, errorMessage: string): void {
    const entry = this.entryFor(key);
    if (!entry) return;

    if (this.sharedRuntime) {
      const snapshot = this.sharedRuntime.coordinator.markQuotaError(this.sharedCandidate(entry), {
        now: Date.now(),
        message: errorMessage,
        category: 'hard_limit',
        autoDisable: true,
        maxErrors: this._keyMaxErrors,
      });
      this.applySharedSnapshot(entry, snapshot, true, false);
      this.selector.notifyKeyUnavailable(key);
      this.signalAvailabilityChange();
      return;
    }

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
    this.autoRecovery.schedule();
    this.selector.notifyKeyUnavailable(key);
    this.signalAvailabilityChange();
  }

  markRateLimited(key: string, errorMessage: string): void {
    const entry = this.entryFor(key);
    if (!entry) return;

    const now = Date.now();
    if (this.sharedRuntime) {
      const delay = randomBetween(this._antiBan.rate_limit_delay_min_ms, this._antiBan.rate_limit_delay_max_ms);
      const snapshot = this.sharedRuntime.coordinator.markRateLimited(this.sharedCandidate(entry), {
        now,
        message: errorMessage,
        category: 'rate_limit',
        autoDisable: this._autoDisable,
        maxErrors: this._keyMaxErrors,
        delayMs: delay,
      });
      this.applySharedSnapshot(entry, snapshot, true, false);
      if (this._antiBan.sticky_on_cooldown === 'fallthrough') {
        this.selector.notifyKeyUnavailable(key);
      }
      this.signalAvailabilityChange();
      return;
    }
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
    if (patch.auto_disabled_at != null) this.autoRecovery.schedule();
    if (this._antiBan.sticky_on_cooldown === 'fallthrough') {
      this.selector.notifyKeyUnavailable(key);
    }
    this.signalAvailabilityChange();
  }

  markSuccess(key: string): void {
    const entry = this.entryFor(key);
    if (!entry) return;
    if (this.sharedRuntime) {
      const snapshot = this.sharedRuntime.coordinator.markSuccess(this.sharedCandidate(entry), Date.now());
      this.applySharedSnapshot(entry, snapshot, true, false);
      return;
    }
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

  recordUsage(
    key: string,
    requests: number,
    tokens: number,
    detail: Pick<KeyUsageDelta, 'inputTokens' | 'outputTokens'> = {},
  ): void {
    const entry = this.entryFor(key);
    const delta: KeyUsageDelta = { requests, tokens, ...detail };
    if (entry && this.sharedRuntime) {
      const snapshot = this.sharedRuntime.coordinator.recordUsage(
        this.sharedCandidate(entry),
        delta,
        Date.now(),
      );
      this.applySharedSnapshot(entry, snapshot, false, true);
      this.signalAvailabilityChange();
      return;
    }
    this.quotaGuard.recordUsage(key, delta);
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
    const entry = this.entryFor(key);
    if (entry && this.sharedRuntime) {
      const snapshot = this.sharedRuntime.coordinator.resetUsage(this.sharedCandidate(entry), Date.now());
      this.applySharedSnapshot(entry, snapshot, false, true);
      this.signalAvailabilityChange();
      return;
    }
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
    const entry = this.entryFor(key);
    if (entry && this.sharedRuntime) {
      const snapshot = this.sharedRuntime.coordinator.snapshot(this.sharedCandidate(entry), Date.now());
      this.applySharedSnapshot(entry, snapshot, false, false);
    }
    return {
      usage: this.quotaGuard.getUsage(key),
      quota: this.quotaGuard.getQuota(key),
      blocked: this.quotaGuard.isBlocked(key),
      reason: this.quotaGuard.lastBlockReason(key)
    };
  }

  allUnavailable(): boolean {
    if (this.sharedRuntime) {
      if (this._keys.length === 0) return true;
      const now = Date.now();
      return this._keys.every((entry) => {
        const snapshot = this.sharedRuntime!.coordinator.snapshot(this.sharedCandidate(entry), now);
        this.applySharedSnapshot(entry, snapshot, false, false);
        return !snapshot.enabled || snapshot.quotaBlocked;
      });
    }
    this.autoRecovery.recoverExpired(Date.now());
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
    if (this.sharedRuntime) {
      const candidate = { ...this.sharedCandidate(entry), configuredEnabled: true };
      const snapshot = this.sharedRuntime.coordinator.setEnabled(candidate, true, Date.now());
      this.applySharedSnapshot(entry, snapshot, true, false);
      this.signalAvailabilityChange();
      return;
    }
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
    this.autoRecovery.schedule();
    this.signalAvailabilityChange();
  }

  disableKey(key: string, reason?: string): void {
    const entry = this.entryFor(key);
    if (!entry) return;
    if (this.sharedRuntime) {
      const snapshot = this.sharedRuntime.coordinator.setEnabled(
        this.sharedCandidate(entry),
        false,
        Date.now(),
        reason,
      );
      this.applySharedSnapshot(entry, snapshot, true, false);
      this.signalAvailabilityChange();
      return;
    }
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
    this.autoRecovery.schedule();
    this.signalAvailabilityChange();
  }

  resetErrorCount(key: string): void {
    const entry = this.entryFor(key);
    if (!entry) return;
    if (this.sharedRuntime) {
      const candidate = { ...this.sharedCandidate(entry), configuredEnabled: true };
      const snapshot = this.sharedRuntime.coordinator.reset(candidate, Date.now());
      this.applySharedSnapshot(entry, snapshot, true, false);
      this.signalAvailabilityChange();
      return;
    }
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
    this.autoRecovery.schedule();
    this.signalAvailabilityChange();
  }

  getKeys(): ApiKeyEntry[] {
    return this._keys;
  }

  getKeyStatuses(): KeyRuntimeStatus[] {
    const now = Date.now();
    if (this.sharedRuntime) {
      return this._keys.map((entry) => {
        const snapshot = this.sharedRuntime!.coordinator.snapshot(this.sharedCandidate(entry), now);
        this.applySharedSnapshot(entry, snapshot, false, false);
        return this.statusFromSharedSnapshot(entry, snapshot, now);
      });
    }
    this.autoRecovery.recoverExpired(now);
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
    this.autoRecovery.dispose();
    // 热更新只停止旧实例的后台写入；已持有该实例的在途请求仍需完成等待、重试和 lease 释放。
    this._onChange = undefined;
    this.usageListener = null;
  }

  private entryFor(key: string): ApiKeyEntry | undefined {
    const idx = this._keyIndex.get(key);
    return idx === undefined ? undefined : this._keys[idx];
  }

  private entryForCompositeKey(compositeKey: string): ApiKeyEntry | undefined {
    if (!this.sharedRuntime) return undefined;
    const prefix = `${this.sharedRuntime.providerId}:`;
    if (!compositeKey.startsWith(prefix)) return undefined;
    const keyId = compositeKey.slice(prefix.length);
    return this._keys.find((entry) => entry.id === keyId);
  }

  private sharedCandidate(entry: ApiKeyEntry): SharedKeyCandidate {
    if (!this.sharedRuntime) throw new Error('当前 Rotator 未启用共享运行态');
    const effectiveQuota = entry.quota !== undefined ? entry.quota : this._providerQuota;
    return {
      compositeKey: `${this.sharedRuntime.providerId}:${entry.id}`,
      // 自动禁用会暂时把 enabled 置为 false；auto_disabled_at 可区分它与用户主动停用。
      configuredEnabled: entry.auto_disabled_at != null || entry.enabled !== false,
      maxConcurrent: this._antiBan.max_concurrent,
      minIntervalMs: this._antiBan.min_interval_ms,
      autoRecoverMs: this._autoRecoverMs,
      quota: effectiveQuota,
    };
  }

  private orderedSharedCandidates(): SharedKeyCandidate[] {
    const keys = this._keys.map((entry) => entry.key);
    const preferred = this.selector.pick(keys);
    const ordered = preferred ? [preferred, ...keys.filter((key) => key !== preferred)] : keys;
    return ordered.flatMap((key) => {
      const entry = this.entryFor(key);
      return entry ? [this.sharedCandidate(entry)] : [];
    });
  }

  private applySharedSnapshot(
    entry: ApiKeyEntry,
    snapshot: SharedKeySnapshot,
    notifyState: boolean,
    notifyUsage: boolean,
  ): void {
    const patch: KeyStateChange = {
      enabled: snapshot.enabled,
      error_count: snapshot.errorCount,
      disabled_at: snapshot.disabledAt,
      last_error_at: snapshot.lastErrorAt,
      last_error_message: snapshot.lastErrorMessage,
      auto_disabled_at: snapshot.autoDisabledAt,
    };
    const changed = Object.entries(patch).some(([field, value]) => (
      entry[field as keyof ApiKeyEntry] !== value
    ));
    Object.assign(entry, patch);
    const state = this.getRuntimeState(entry.key);
    state.activeRequests = snapshot.activeLeases;
    state.activeLeaseStarts = [];
    state.nextAvailableAt = snapshot.nextAvailableAt;
    state.lastSentAt = snapshot.lastSentAt;
    state.lastErrorCategory = snapshot.lastErrorCategory;
    this.quotaGuard.hydrate(entry.key, snapshot.usage);
    if (notifyState && changed) this._onChange?.(entry.key, patch);
    if (notifyUsage) this.notifyUsage(entry.key);
  }

  private statusFromSharedSnapshot(
    entry: ApiKeyEntry,
    snapshot: SharedKeySnapshot,
    now: number,
  ): KeyRuntimeStatus {
    const delayed = snapshot.enabled
      && snapshot.nextAvailableAt != null
      && snapshot.nextAvailableAt > now;
    const busy = snapshot.enabled && !delayed && snapshot.activeLeases >= this._antiBan.max_concurrent;
    return {
      ...entry,
      status: !snapshot.enabled ? 'disabled' : delayed ? 'delayed' : busy ? 'busy' : 'available',
      active_requests: snapshot.activeLeases,
      next_available_at: delayed ? snapshot.nextAvailableAt : null,
      last_error_category: snapshot.lastErrorCategory,
      disabled_reason: !snapshot.enabled ? snapshot.lastErrorMessage : null,
      usage: snapshot.usage,
      quota: this.quotaGuard.getQuota(entry.key),
      quota_blocked: snapshot.quotaBlocked,
      quota_reason: snapshot.quotaReason,
    };
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

function normalizeLeaseTtl(value: number | undefined): number {
  if (value == null) return LEASE_MAX_AGE_MS;
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.trunc(value)) : LEASE_MAX_AGE_MS;
}
