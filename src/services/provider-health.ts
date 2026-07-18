import type { CircuitBreakerConfig } from '../types/runtime-config.js';

export type ProviderFailureKind = 'network' | 'server';

export interface ProviderCircuitLease {
  providerId: string;
  probe: boolean;
  generation: number;
  leaseId: number;
}

export interface ProviderCircuitSnapshot {
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  openUntil: number | null;
}

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

/**
 * Provider 级熔断状态只保留在当前进程内；它描述的是短期链路健康度，
 * 不应写入用户配置或跨重启继承，避免旧故障阻塞刚恢复的 Provider。
 */
export class ProviderHealthRegistry {
  private readonly states = new Map<string, ProviderCircuitState>();
  private nextLeaseId = 0;

  configure(providerId: string, config?: CircuitBreakerConfig | null): void {
    const state = this.getOrCreate(providerId);
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
    if (!state.enabled || state.openUntil === 0) return true;
    if (now < state.openUntil) return false;
    // 冷却结束后，只有一个请求可以进入半开；其他请求必须继续等待下一次结果。
    return state.probeLeaseId === null;
  }

  acquire(providerId: string, now = Date.now()): ProviderCircuitLease | null {
    const state = this.getOrCreate(providerId);
    const leaseId = ++this.nextLeaseId;
    if (!state.enabled || state.openUntil === 0) {
      return { providerId, probe: false, generation: state.generation, leaseId };
    }
    if (now < state.openUntil || state.probeLeaseId !== null) return null;
    state.probeLeaseId = leaseId;
    return { providerId, probe: true, generation: state.generation, leaseId };
  }

  recordSuccess(providerId: string, lease?: ProviderCircuitLease): void {
    const state = this.getOrCreate(providerId);
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
  }

  release(providerId: string, lease?: ProviderCircuitLease): void {
    if (!lease?.probe) return;
    const state = this.getOrCreate(providerId);
    if (!this.isCurrentLease(providerId, state, lease)) return;
    if (state.probeLeaseId === lease.leaseId) state.probeLeaseId = null;
  }

  isOpen(providerId: string, now = Date.now()): boolean {
    const state = this.getOrCreate(providerId);
    return state.enabled && state.openUntil > now;
  }

  snapshot(providerId: string, now = Date.now()): ProviderCircuitSnapshot {
    const state = this.getOrCreate(providerId);
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
