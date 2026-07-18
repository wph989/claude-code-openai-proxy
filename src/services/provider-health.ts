import type { CircuitBreakerConfig } from '../types/runtime-config.js';

export type ProviderFailureKind = 'network' | 'server';

export interface ProviderCircuitLease {
  providerId: string;
  probe: boolean;
}

interface ProviderCircuitState {
  enabled: boolean;
  failureThreshold: number;
  recoveryMs: number;
  consecutiveFailures: number;
  openUntil: number;
  halfOpenInFlight: boolean;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_RECOVERY_MS = 30_000;

/**
 * Provider 级熔断状态只保留在当前进程内；它描述的是短期链路健康度，
 * 不应写入用户配置或跨重启继承，避免旧故障阻塞刚恢复的 Provider。
 */
export class ProviderHealthRegistry {
  private readonly states = new Map<string, ProviderCircuitState>();

  configure(providerId: string, config?: CircuitBreakerConfig | null): void {
    const state = this.getOrCreate(providerId);
    if (config === null) {
      state.enabled = false;
      state.consecutiveFailures = 0;
      state.openUntil = 0;
      state.halfOpenInFlight = false;
      return;
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
    return !state.halfOpenInFlight;
  }

  acquire(providerId: string, now = Date.now()): ProviderCircuitLease | null {
    const state = this.getOrCreate(providerId);
    if (!state.enabled || state.openUntil === 0) return { providerId, probe: false };
    if (now < state.openUntil || state.halfOpenInFlight) return null;
    state.halfOpenInFlight = true;
    return { providerId, probe: true };
  }

  recordSuccess(providerId: string, _lease?: ProviderCircuitLease): void {
    const state = this.getOrCreate(providerId);
    if (!state.enabled) return;
    state.consecutiveFailures = 0;
    state.openUntil = 0;
    state.halfOpenInFlight = false;
  }

  recordFailure(
    providerId: string,
    _kind: ProviderFailureKind,
    lease?: ProviderCircuitLease,
    now = Date.now(),
  ): void {
    const state = this.getOrCreate(providerId);
    if (!state.enabled) return;
    state.halfOpenInFlight = false;
    state.consecutiveFailures += 1;
    if (lease?.probe || state.consecutiveFailures >= state.failureThreshold) {
      state.openUntil = now + state.recoveryMs;
    }
  }

  release(providerId: string, lease?: ProviderCircuitLease): void {
    if (!lease?.probe) return;
    this.getOrCreate(providerId).halfOpenInFlight = false;
  }

  isOpen(providerId: string, now = Date.now()): boolean {
    const state = this.getOrCreate(providerId);
    return state.enabled && state.openUntil > now;
  }

  snapshot(providerId: string, now = Date.now()): {
    state: 'closed' | 'open' | 'half_open';
    consecutiveFailures: number;
    openUntil: number | null;
  } {
    const state = this.getOrCreate(providerId);
    if (!state.enabled || state.openUntil === 0) {
      return { state: 'closed', consecutiveFailures: state.consecutiveFailures, openUntil: null };
    }
    if (state.openUntil > now) {
      return { state: 'open', consecutiveFailures: state.consecutiveFailures, openUntil: state.openUntil };
    }
    return {
      state: state.halfOpenInFlight ? 'half_open' : 'closed',
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
        halfOpenInFlight: false,
      };
      this.states.set(providerId, state);
    }
    return state;
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
