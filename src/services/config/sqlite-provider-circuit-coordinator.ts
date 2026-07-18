import { randomUUID } from 'node:crypto';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import type {
  ProviderCircuitCoordinator,
  ProviderCircuitLease,
  ProviderCircuitPolicy,
  ProviderCircuitSnapshot,
} from '../provider-circuit-coordinator.js';

interface CircuitRow {
  consecutive_failures: number;
  open_until: number;
  probe_lease_id: string | null;
  probe_expires_at: number | null;
  generation: number;
}

export class SqliteProviderCircuitCoordinator implements ProviderCircuitCoordinator {
  constructor(private readonly db: NodeDatabaseSync) {}

  configure(providerId: string, policy: ProviderCircuitPolicy, now: number): void {
    withImmediateTransaction(this.db, () => {
      this.ensure(providerId, now);
      if (policy.enabled) return;
      this.db.prepare(`
        UPDATE provider_circuits SET
          consecutive_failures = 0,
          open_until = 0,
          probe_lease_id = NULL,
          probe_expires_at = NULL,
          generation = generation + 1,
          updated_at = ?
        WHERE provider_id = ?
      `).run(now, providerId);
    });
  }

  isAvailable(providerId: string, policy: ProviderCircuitPolicy, now: number): boolean {
    if (!policy.enabled) return true;
    return withImmediateTransaction(this.db, () => {
      const row = this.loadCurrent(providerId, now);
      if (row.open_until === 0) return true;
      if (now < row.open_until) return false;
      return row.probe_lease_id === null;
    });
  }

  acquire(
    providerId: string,
    policy: ProviderCircuitPolicy,
    now: number,
    probeLeaseTtlMs: number,
  ): ProviderCircuitLease | null {
    return withImmediateTransaction(this.db, () => {
      const row = this.loadCurrent(providerId, now);
      const leaseId = randomUUID();
      if (!policy.enabled || row.open_until === 0) {
        return { providerId, probe: false, generation: row.generation, leaseId };
      }
      if (now < row.open_until || row.probe_lease_id !== null) return null;
      this.db.prepare(`
        UPDATE provider_circuits SET
          probe_lease_id = ?, probe_expires_at = ?, updated_at = ?
        WHERE provider_id = ?
      `).run(leaseId, now + probeLeaseTtlMs, now, providerId);
      return { providerId, probe: true, generation: row.generation, leaseId };
    });
  }

  recordSuccess(
    providerId: string,
    policy: ProviderCircuitPolicy,
    lease: ProviderCircuitLease | undefined,
    now: number,
  ): void {
    if (!policy.enabled) return;
    withImmediateTransaction(this.db, () => {
      const row = this.loadCurrent(providerId, now);
      if (!isCurrentLease(providerId, row, lease)) return;
      if (lease?.probe && row.probe_lease_id !== String(lease.leaseId)) return;
      if (!lease?.probe && row.open_until !== 0) return;
      this.db.prepare(`
        UPDATE provider_circuits SET
          consecutive_failures = 0,
          open_until = 0,
          probe_lease_id = NULL,
          probe_expires_at = NULL,
          generation = generation + ?,
          updated_at = ?
        WHERE provider_id = ?
      `).run(lease?.probe ? 1 : 0, now, providerId);
    });
  }

  recordFailure(
    providerId: string,
    policy: ProviderCircuitPolicy,
    lease: ProviderCircuitLease | undefined,
    now: number,
  ): void {
    if (!policy.enabled) return;
    withImmediateTransaction(this.db, () => {
      const row = this.loadCurrent(providerId, now);
      if (!isCurrentLease(providerId, row, lease)) return;
      if (lease?.probe && row.probe_lease_id !== String(lease.leaseId)) return;
      if (!lease?.probe && row.open_until !== 0) return;
      const failures = row.consecutive_failures + 1;
      const shouldOpen = lease?.probe === true || failures >= policy.failureThreshold;
      this.db.prepare(`
        UPDATE provider_circuits SET
          consecutive_failures = ?,
          open_until = ?,
          probe_lease_id = NULL,
          probe_expires_at = NULL,
          generation = generation + ?,
          updated_at = ?
        WHERE provider_id = ?
      `).run(
        failures,
        shouldOpen ? now + policy.recoveryMs : row.open_until,
        shouldOpen ? 1 : 0,
        now,
        providerId,
      );
    });
  }

  release(
    providerId: string,
    policy: ProviderCircuitPolicy,
    lease: ProviderCircuitLease | undefined,
    now: number,
  ): void {
    if (!policy.enabled || !lease?.probe) return;
    withImmediateTransaction(this.db, () => {
      const row = this.loadCurrent(providerId, now);
      if (!isCurrentLease(providerId, row, lease)) return;
      if (row.probe_lease_id !== String(lease.leaseId)) return;
      this.db.prepare(`
        UPDATE provider_circuits SET
          probe_lease_id = NULL, probe_expires_at = NULL, updated_at = ?
        WHERE provider_id = ?
      `).run(now, providerId);
    });
  }

  snapshot(providerId: string, policy: ProviderCircuitPolicy, now: number): ProviderCircuitSnapshot {
    if (!policy.enabled) return { state: 'closed', consecutiveFailures: 0, openUntil: null };
    return withImmediateTransaction(this.db, () => {
      const row = this.loadCurrent(providerId, now);
      if (row.open_until === 0) {
        return { state: 'closed', consecutiveFailures: row.consecutive_failures, openUntil: null };
      }
      return {
        state: row.open_until > now ? 'open' : 'half_open',
        consecutiveFailures: row.consecutive_failures,
        openUntil: row.open_until,
      };
    });
  }

  private loadCurrent(providerId: string, now: number): CircuitRow {
    this.ensure(providerId, now);
    let row = this.load(providerId);
    if (row.probe_lease_id !== null
      && row.probe_expires_at !== null
      && row.probe_expires_at <= now) {
      // 半开探测 Worker 崩溃后必须释放探测权，否则 Provider 会永久停在 half_open。
      this.db.prepare(`
        UPDATE provider_circuits SET
          probe_lease_id = NULL, probe_expires_at = NULL, updated_at = ?
        WHERE provider_id = ?
      `).run(now, providerId);
      row = { ...row, probe_lease_id: null, probe_expires_at: null };
    }
    return row;
  }

  private ensure(providerId: string, now: number): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO provider_circuits(
        provider_id, consecutive_failures, open_until, generation, updated_at
      ) VALUES(?, 0, 0, 0, ?)
    `).run(providerId, now);
  }

  private load(providerId: string): CircuitRow {
    return this.db.prepare(`
      SELECT consecutive_failures, open_until, probe_lease_id, probe_expires_at, generation
      FROM provider_circuits WHERE provider_id = ?
    `).get(providerId) as unknown as CircuitRow;
  }
}

function isCurrentLease(
  providerId: string,
  row: CircuitRow,
  lease: ProviderCircuitLease | undefined,
): boolean {
  return !lease || lease.providerId === providerId && lease.generation === row.generation;
}

function withImmediateTransaction<T>(db: NodeDatabaseSync, callback: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 原错误优先。 */ }
    throw error;
  }
}
