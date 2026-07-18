import type { CircuitBreakerConfig } from '../types/runtime-config.js';
import type {
  ProviderCircuitCoordinator,
  ProviderCircuitLease,
  ProviderCircuitPolicy,
  ProviderCircuitSnapshot,
} from './provider-circuit-coordinator.js';

export type { ProviderCircuitLease, ProviderCircuitSnapshot } from './provider-circuit-coordinator.js';

export type ProviderFailureKind = 'network' | 'server';

interface ProviderCircuitState {
  enabled: boolean;
  failureThreshold: number;
  recoveryMs: number;
  consecutiveFailures: number;
  openUntil: number;
  probeLeaseId: number | null;
  generation: number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_RECOVERY_MS = 30_000;
const DEFAULT_PROBE_LEASE_TTL_MS = 10 * 60 * 1000;

export interface ProviderHealthRegistryOptions {
  probeLeaseTtlMs?: number;
  onOpened?: (providerId: string, snapshot: ProviderCircuitSnapshot) => void;
}

/**
 * 默认使用进程内短期状态；注入事务协调器后，所有 Worker 共享熔断代际和半开探测权。
 */
export class ProviderHealthRegistry {
  private readonly states = new Map<string, ProviderCircuitState>();
  private nextLeaseId = 0;

  constructor(
    private readonly coordinator?: ProviderCircuitCoordinator,
    private readonly options: ProviderHealthRegistryOptions = {},
  ) {}

  configure(providerId: string, config?: CircuitBreakerConfig | null): void {
    const state = this.getOrCreate(providerId);
    if (this.coordinator) {
      const enabled = config !== null;
      const failureThreshold = normalizeThreshold(config?.failure_threshold);
      const recoveryMs = normalizeRecoveryMs(config?.recovery_seconds);
      const changed = state.enabled !== enabled
        || state.failureThreshold !== failureThreshold
        || state.recoveryMs !== recoveryMs;
      state.enabled = enabled;
      state.failureThreshold = failureThreshold;
      state.recoveryMs = recoveryMs;
      if (changed) this.coordinator.configure(providerId, this.policy(state), Date.now());
      return;
    }
    if (config === null) {
      // 切换开关时递增代际，使关闭前已经发出的请求不能再修改重新启用后的状态。
      state.generation += 1;
      state.enabled = false;
      state.consecutiveFailures = 0;
      state.openUntil = 0;
      state.probeLeaseId = null;
      return;
    }
    if (!state.enabled) {
      state.generation += 1;
      state.consecutiveFailures = 0;
      state.openUntil = 0;
      state.probeLeaseId = null;
    }
    state.enabled = true;
    state.failureThreshold = normalizeThreshold(config?.failure_threshold);
    state.recoveryMs = normalizeRecoveryMs(config?.recovery_seconds);
  }

  isAvailable(providerId: string, now = Date.now()): boolean {
    const state = this.getOrCreate(providerId);
    if (this.coordinator) return this.coordinator.isAvailable(providerId, this.policy(state), now);
    if (!state.enabled || state.openUntil === 0) return true;
    if (now < state.openUntil) return false;
    // 冷却结束后，只有一个请求可以进入半开；其他请求必须继续等待下一次结果。
    return state.probeLeaseId === null;
  }

  acquire(providerId: string, now = Date.now()): ProviderCircuitLease | null {
    const state = this.getOrCreate(providerId);
    if (this.coordinator) {
      return this.coordinator.acquire(
        providerId,
        this.policy(state),
        now,
        normalizeProbeLeaseTtl(this.options.probeLeaseTtlMs),
      );
    }
    const leaseId = ++this.nextLeaseId;
    if (!state.enabled || state.openUntil === 0) {
      return { providerId, probe: false, generation: state.generation, leaseId };
    }
    if (now < state.openUntil || state.probeLeaseId !== null) return null;
    state.probeLeaseId = leaseId;
    return { providerId, probe: true, generation: state.generation, leaseId };
  }

  recordSuccess(providerId: string, lease?: ProviderCircuitLease, now = Date.now()): void {
    const state = this.getOrCreate(providerId);
    if (this.coordinator) {
      this.coordinator.recordSuccess(providerId, this.policy(state), lease, now);
      return;
    }
    if (!state.enabled) return;
    if (lease && !this.isCurrentLease(providerId, state, lease)) return;
    if (lease?.probe && state.probeLeaseId !== lease.leaseId) return;
    if (!lease?.probe && state.openUntil !== 0) return;
    state.consecutiveFailures = 0;
    state.openUntil = 0;
    state.probeLeaseId = null;
    if (lease?.probe) state.generation += 1;
  }

  recordFailure(
    providerId: string,
    _kind: ProviderFailureKind,
    lease?: ProviderCircuitLease,
    now = Date.now(),
  ): void {
    const state = this.getOrCreate(providerId);
    if (this.coordinator) {
      this.coordinator.recordFailure(providerId, this.policy(state), lease, now);
      this.notifyIfOpened(providerId, now);
      return;
    }
    if (!state.enabled) return;
    if (lease && !this.isCurrentLease(providerId, state, lease)) return;
    if (lease?.probe && state.probeLeaseId !== lease.leaseId) return;
    if (!lease?.probe && state.openUntil !== 0) return;
    state.probeLeaseId = null;
    state.consecutiveFailures += 1;
    if (lease?.probe || state.consecutiveFailures >= state.failureThreshold) {
      state.openUntil = now + state.recoveryMs;
      // 熔断打开后，忽略同一批并发请求稍后到达的结果，避免旧成功误关刚打开的熔断。
      state.generation += 1;
    }
    this.notifyIfOpened(providerId, now);
  }

  release(providerId: string, lease?: ProviderCircuitLease, now = Date.now()): void {
    if (!lease?.probe) return;
    const state = this.getOrCreate(providerId);
    if (this.coordinator) {
      this.coordinator.release(providerId, this.policy(state), lease, now);
      return;
    }
    if (!this.isCurrentLease(providerId, state, lease)) return;
    if (state.probeLeaseId === lease.leaseId) state.probeLeaseId = null;
  }

  isOpen(providerId: string, now = Date.now()): boolean {
    const state = this.getOrCreate(providerId);
    if (this.coordinator) return this.coordinator.snapshot(providerId, this.policy(state), now).state === 'open';
    return state.enabled && state.openUntil > now;
  }

  snapshot(providerId: string, now = Date.now()): ProviderCircuitSnapshot {
    const state = this.getOrCreate(providerId);
    if (this.coordinator) return this.coordinator.snapshot(providerId, this.policy(state), now);
    if (!state.enabled || state.openUntil === 0) {
      return { state: 'closed', consecutiveFailures: state.consecutiveFailures, openUntil: null };
    }
    if (state.openUntil > now) {
      return { state: 'open', consecutiveFailures: state.consecutiveFailures, openUntil: state.openUntil };
    }
    return {
      state: 'half_open',
      consecutiveFailures: state.consecutiveFailures,
      openUntil: state.openUntil,
    };
  }

  private getOrCreate(providerId: string): ProviderCircuitState {
    let state = this.states.get(providerId);
    if (!state) {
      state = {
        enabled: true,
        failureThreshold: DEFAULT_FAILURE_THRESHOLD,
        recoveryMs: DEFAULT_RECOVERY_MS,
        consecutiveFailures: 0,
        openUntil: 0,
        probeLeaseId: null,
        generation: 0,
      };
      this.states.set(providerId, state);
    }
    return state;
  }

  private isCurrentLease(providerId: string, state: ProviderCircuitState, lease: ProviderCircuitLease): boolean {
    return lease.providerId === providerId && lease.generation === state.generation;
  }

  private policy(state: ProviderCircuitState): ProviderCircuitPolicy {
    return {
      enabled: state.enabled,
      failureThreshold: state.failureThreshold,
      recoveryMs: state.recoveryMs,
    };
  }

  private notifyIfOpened(providerId: string, now: number): void {
    if (!this.options.onOpened) return;
    const snapshot = this.snapshot(providerId, now);
    if (snapshot.state === 'open') this.options.onOpened(providerId, snapshot);
  }
}

function normalizeThreshold(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 1
    ? Math.min(100, Math.trunc(Number(value)))
    : DEFAULT_FAILURE_THRESHOLD;
}

function normalizeRecoveryMs(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 1
    ? Math.min(3600, Math.trunc(Number(value))) * 1000
    : DEFAULT_RECOVERY_MS;
}

function normalizeProbeLeaseTtl(value: number | undefined): number {
  if (value == null) return DEFAULT_PROBE_LEASE_TTL_MS;
  return Number.isFinite(value) && value > 0
    ? Math.max(1, Math.trunc(value))
    : DEFAULT_PROBE_LEASE_TTL_MS;
}
