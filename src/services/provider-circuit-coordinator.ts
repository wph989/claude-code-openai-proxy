export interface ProviderCircuitPolicy {
  enabled: boolean;
  failureThreshold: number;
  recoveryMs: number;
}

export interface ProviderCircuitLease {
  providerId: string;
  probe: boolean;
  generation: number;
  leaseId: number | string;
}

export interface ProviderCircuitSnapshot {
  state: 'closed' | 'open' | 'half_open';
  consecutiveFailures: number;
  openUntil: number | null;
}

/** Provider 熔断事务端口；SQLite 实现让所有 Worker 共享一个半开探测权。 */
export interface ProviderCircuitCoordinator {
  configure(providerId: string, policy: ProviderCircuitPolicy, now: number): void;
  isAvailable(providerId: string, policy: ProviderCircuitPolicy, now: number): boolean;
  acquire(
    providerId: string,
    policy: ProviderCircuitPolicy,
    now: number,
    probeLeaseTtlMs: number,
  ): ProviderCircuitLease | null;
  recordSuccess(
    providerId: string,
    policy: ProviderCircuitPolicy,
    lease: ProviderCircuitLease | undefined,
    now: number,
  ): void;
  recordFailure(
    providerId: string,
    policy: ProviderCircuitPolicy,
    lease: ProviderCircuitLease | undefined,
    now: number,
  ): void;
  release(
    providerId: string,
    policy: ProviderCircuitPolicy,
    lease: ProviderCircuitLease | undefined,
    now: number,
  ): void;
  snapshot(providerId: string, policy: ProviderCircuitPolicy, now: number): ProviderCircuitSnapshot;
}
