import { randomUUID } from 'node:crypto';
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import type { KeyErrorCategory } from '../api-key-rotator.js';
import type {
  KeyRuntimeCoordinator,
  SharedAcquireResult,
  SharedFailureOptions,
  SharedKeyCandidate,
  SharedKeySnapshot,
} from '../key-runtime-coordinator.js';
import type { KeyQuotaConfig, KeyUsage } from '../../types/runtime-config.js';

interface RuntimeRow {
  enabled: number | null;
  error_count: number;
  disabled_at: number | null;
  last_error_at: number | null;
  last_error_message: string | null;
  auto_disabled_at: number | null;
  next_available_at: number | null;
  last_sent_at: number | null;
  last_error_category: string | null;
}

interface UsageRow {
  requests_used: number;
  tokens_used: number;
}

export class SqliteKeyRuntimeCoordinator implements KeyRuntimeCoordinator {
  constructor(
    private readonly db: NodeDatabaseSync,
    private readonly workerId: string,
  ) {}

  tryAcquire(candidates: SharedKeyCandidate[], now: number, leaseTtlMs: number): SharedAcquireResult {
    return withImmediateTransaction(this.db, () => {
      this.sweepExpiredLeases(now);
      let hasPotentialCandidate = false;
      let nextAvailableAt: number | null = null;
      for (const candidate of candidates) {
        const row = this.loadAndRecover(candidate, now);
        const usage = this.loadUsage(candidate.compositeKey);
        const quota = evaluateQuota(usage, candidate.quota);
        const enabled = effectiveEnabled(row, candidate);
        if (!enabled || quota.blocked) continue;
        hasPotentialCandidate = true;

        if (row.next_available_at != null && row.next_available_at > now) {
          nextAvailableAt = minNullable(nextAvailableAt, row.next_available_at);
          continue;
        }
        if (row.last_sent_at != null && row.last_sent_at + candidate.minIntervalMs > now) {
          nextAvailableAt = minNullable(nextAvailableAt, row.last_sent_at + candidate.minIntervalMs);
          continue;
        }
        const leases = this.db.prepare(`
          SELECT COUNT(*) AS count, MIN(expires_at) AS first_expiry
          FROM key_leases WHERE composite_key = ? AND expires_at > ?
        `).get(candidate.compositeKey, now) as { count: number; first_expiry: number | null };
        if (leases.count >= candidate.maxConcurrent) {
          if (leases.first_expiry != null) nextAvailableAt = minNullable(nextAvailableAt, leases.first_expiry);
          continue;
        }

        const leaseId = randomUUID();
        const expiresAt = now + leaseTtlMs;
        this.db.prepare(`
          INSERT INTO key_leases(lease_id, composite_key, worker_id, acquired_at, expires_at)
          VALUES(?, ?, ?, ?, ?)
        `).run(leaseId, candidate.compositeKey, this.workerId, now, expiresAt);
        this.db.prepare('UPDATE key_states SET last_sent_at = ?, updated_at = ? WHERE composite_key = ?')
          .run(now, now, candidate.compositeKey);
        const snapshot = this.buildSnapshot(candidate, { ...row, last_sent_at: now }, usage, now, leases.count + 1);
        return {
          lease: { leaseId, compositeKey: candidate.compositeKey, expiresAt },
          snapshot,
          hasPotentialCandidate: true,
          nextAvailableAt: null,
        };
      }
      return { lease: null, snapshot: null, hasPotentialCandidate, nextAvailableAt };
    });
  }

  release(leaseId: string): void {
    this.db.prepare('DELETE FROM key_leases WHERE lease_id = ?').run(leaseId);
  }

  markError(candidate: SharedKeyCandidate, options: SharedFailureOptions): SharedKeySnapshot {
    return this.recordFailure(candidate, options, false, null);
  }

  markQuotaError(candidate: SharedKeyCandidate, options: SharedFailureOptions): SharedKeySnapshot {
    return this.recordFailure(candidate, options, true, null);
  }

  markRateLimited(
    candidate: SharedKeyCandidate,
    options: SharedFailureOptions & { delayMs: number },
  ): SharedKeySnapshot {
    return this.recordFailure(candidate, options, false, options.delayMs);
  }

  markSuccess(candidate: SharedKeyCandidate, now: number): SharedKeySnapshot {
    return withImmediateTransaction(this.db, () => {
      const row = this.loadAndRecover(candidate, now);
      this.db.prepare(`
        UPDATE key_states SET
          error_count = 0,
          last_error_at = NULL,
          last_error_message = NULL,
          last_error_category = NULL,
          updated_at = ?
        WHERE composite_key = ?
      `).run(now, candidate.compositeKey);
      return this.snapshotInTransaction(candidate, now, {
        ...row,
        error_count: 0,
        last_error_at: null,
        last_error_message: null,
        last_error_category: null,
      });
    });
  }

  setEnabled(candidate: SharedKeyCandidate, enabled: boolean, now: number, reason?: string): SharedKeySnapshot {
    return withImmediateTransaction(this.db, () => {
      this.ensureState(candidate.compositeKey, now);
      this.db.prepare(`
        UPDATE key_states SET
          enabled = ?,
          error_count = CASE WHEN ? = 1 THEN 0 ELSE error_count END,
          disabled_at = CASE WHEN ? = 1 THEN NULL ELSE ? END,
          auto_disabled_at = NULL,
          next_available_at = CASE WHEN ? = 1 THEN NULL ELSE next_available_at END,
          last_error_at = CASE WHEN ? IS NULL THEN last_error_at ELSE ? END,
          last_error_message = CASE WHEN ? IS NULL THEN last_error_message ELSE ? END,
          last_error_category = CASE WHEN ? IS NULL THEN last_error_category ELSE 'hard_limit' END,
          updated_at = ?
        WHERE composite_key = ?
      `).run(
        enabled ? 1 : 0,
        enabled ? 1 : 0,
        enabled ? 1 : 0,
        now,
        enabled ? 1 : 0,
        reason ?? null,
        reason ?? null,
        reason ?? null,
        reason ?? null,
        reason ?? null,
        now,
        candidate.compositeKey,
      );
      return this.snapshotInTransaction(candidate, now);
    });
  }

  reset(candidate: SharedKeyCandidate, now: number): SharedKeySnapshot {
    return withImmediateTransaction(this.db, () => {
      this.ensureState(candidate.compositeKey, now);
      this.db.prepare('DELETE FROM key_leases WHERE composite_key = ?').run(candidate.compositeKey);
      this.db.prepare(`
        UPDATE key_states SET
          enabled = 1,
          error_count = 0,
          disabled_at = NULL,
          last_error_at = NULL,
          last_error_message = NULL,
          auto_disabled_at = NULL,
          next_available_at = NULL,
          last_error_category = NULL,
          updated_at = ?
        WHERE composite_key = ?
      `).run(now, candidate.compositeKey);
      return this.snapshotInTransaction(candidate, now);
    });
  }

  recordUsage(candidate: SharedKeyCandidate, requests: number, tokens: number, now: number): SharedKeySnapshot {
    return withImmediateTransaction(this.db, () => {
      this.ensureState(candidate.compositeKey, now);
      this.db.prepare(`
        INSERT INTO key_usage(composite_key, requests_used, tokens_used, updated_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(composite_key) DO UPDATE SET
          requests_used = key_usage.requests_used + excluded.requests_used,
          tokens_used = key_usage.tokens_used + excluded.tokens_used,
          updated_at = excluded.updated_at
      `).run(candidate.compositeKey, normalizeDelta(requests), normalizeDelta(tokens), now);
      return this.snapshotInTransaction(candidate, now);
    });
  }

  resetUsage(candidate: SharedKeyCandidate, now: number): SharedKeySnapshot {
    return withImmediateTransaction(this.db, () => {
      this.ensureState(candidate.compositeKey, now);
      this.db.prepare(`
        INSERT INTO key_usage(composite_key, requests_used, tokens_used, updated_at)
        VALUES(?, 0, 0, ?)
        ON CONFLICT(composite_key) DO UPDATE SET
          requests_used = 0,
          tokens_used = 0,
          updated_at = excluded.updated_at
      `).run(candidate.compositeKey, now);
      return this.snapshotInTransaction(candidate, now);
    });
  }

  snapshot(candidate: SharedKeyCandidate, now: number): SharedKeySnapshot {
    return withImmediateTransaction(this.db, () => {
      this.sweepExpiredLeases(now);
      return this.snapshotInTransaction(candidate, now);
    });
  }

  private recordFailure(
    candidate: SharedKeyCandidate,
    options: SharedFailureOptions,
    forceDisable: boolean,
    cooldownDelayMs: number | null,
  ): SharedKeySnapshot {
    return withImmediateTransaction(this.db, () => {
      const row = this.loadAndRecover(candidate, options.now);
      const nextErrorCount = row.error_count + 1;
      const shouldDisable = forceDisable
        || options.autoDisable && effectiveEnabled(row, candidate) && nextErrorCount >= options.maxErrors;
      const existingCooldown = row.next_available_at != null && row.next_available_at > options.now
        ? row.next_available_at
        : null;
      const nextCooldown = cooldownDelayMs == null
        ? row.next_available_at
        : existingCooldown ?? options.now + cooldownDelayMs;
      this.db.prepare(`
        UPDATE key_states SET
          enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END,
          error_count = ?,
          disabled_at = CASE WHEN ? = 1 THEN ? ELSE disabled_at END,
          last_error_at = ?,
          last_error_message = ?,
          auto_disabled_at = CASE WHEN ? = 1 THEN ? ELSE auto_disabled_at END,
          next_available_at = ?,
          last_error_category = ?,
          updated_at = ?
        WHERE composite_key = ?
      `).run(
        shouldDisable ? 1 : 0,
        nextErrorCount,
        shouldDisable ? 1 : 0,
        options.now,
        options.now,
        options.message,
        shouldDisable ? 1 : 0,
        options.now,
        nextCooldown,
        options.category,
        options.now,
        candidate.compositeKey,
      );
      return this.snapshotInTransaction(candidate, options.now, {
        ...row,
        enabled: shouldDisable ? 0 : row.enabled,
        error_count: nextErrorCount,
        disabled_at: shouldDisable ? options.now : row.disabled_at,
        last_error_at: options.now,
        last_error_message: options.message,
        auto_disabled_at: shouldDisable ? options.now : row.auto_disabled_at,
        next_available_at: nextCooldown,
        last_error_category: options.category,
      });
    });
  }

  private snapshotInTransaction(
    candidate: SharedKeyCandidate,
    now: number,
    suppliedRow?: RuntimeRow,
  ): SharedKeySnapshot {
    const row = suppliedRow ?? this.loadAndRecover(candidate, now);
    const usage = this.loadUsage(candidate.compositeKey);
    const active = this.db.prepare(
      'SELECT COUNT(*) AS count FROM key_leases WHERE composite_key = ? AND expires_at > ?',
    ).get(candidate.compositeKey, now) as { count: number };
    return this.buildSnapshot(candidate, row, usage, now, active.count);
  }

  private buildSnapshot(
    candidate: SharedKeyCandidate,
    row: RuntimeRow,
    usage: KeyUsage,
    _now: number,
    activeLeases: number,
  ): SharedKeySnapshot {
    const quota = evaluateQuota(usage, candidate.quota);
    return {
      enabled: effectiveEnabled(row, candidate),
      errorCount: row.error_count,
      disabledAt: row.disabled_at,
      lastErrorAt: row.last_error_at,
      lastErrorMessage: row.last_error_message,
      autoDisabledAt: row.auto_disabled_at,
      nextAvailableAt: row.next_available_at,
      lastSentAt: row.last_sent_at,
      lastErrorCategory: normalizeErrorCategory(row.last_error_category),
      activeLeases,
      usage,
      quotaBlocked: quota.blocked,
      quotaReason: quota.reason,
    };
  }

  private loadAndRecover(candidate: SharedKeyCandidate, now: number): RuntimeRow {
    this.ensureState(candidate.compositeKey, now);
    let row = this.loadState(candidate.compositeKey);
    if (row.auto_disabled_at != null
      && candidate.autoRecoverMs > 0
      && now >= row.auto_disabled_at + candidate.autoRecoverMs) {
      this.db.prepare(`
        UPDATE key_states SET
          enabled = 1,
          error_count = 0,
          disabled_at = NULL,
          last_error_at = NULL,
          last_error_message = NULL,
          auto_disabled_at = NULL,
          next_available_at = NULL,
          last_error_category = NULL,
          updated_at = ?
        WHERE composite_key = ?
      `).run(now, candidate.compositeKey);
      row = {
        ...row,
        enabled: 1,
        error_count: 0,
        disabled_at: null,
        last_error_at: null,
        last_error_message: null,
        auto_disabled_at: null,
        next_available_at: null,
        last_error_category: null,
      };
    }
    return row;
  }

  private ensureState(compositeKey: string, now: number): void {
    const { providerId, keyId } = splitCompositeKey(compositeKey);
    this.db.prepare(`
      INSERT OR IGNORE INTO key_states(
        composite_key, provider_id, key_id, error_count, updated_at
      ) VALUES(?, ?, ?, 0, ?)
    `).run(compositeKey, providerId, keyId, now);
    this.db.prepare(`
      INSERT OR IGNORE INTO key_usage(composite_key, requests_used, tokens_used, updated_at)
      VALUES(?, 0, 0, ?)
    `).run(compositeKey, now);
  }

  private loadState(compositeKey: string): RuntimeRow {
    return this.db.prepare(`
      SELECT enabled, error_count, disabled_at, last_error_at, last_error_message,
             auto_disabled_at, next_available_at, last_sent_at, last_error_category
      FROM key_states WHERE composite_key = ?
    `).get(compositeKey) as unknown as RuntimeRow;
  }

  private loadUsage(compositeKey: string): KeyUsage {
    const row = this.db.prepare(
      'SELECT requests_used, tokens_used FROM key_usage WHERE composite_key = ?',
    ).get(compositeKey) as UsageRow | undefined;
    return row
      ? { requests_used: row.requests_used, tokens_used: row.tokens_used }
      : { requests_used: 0, tokens_used: 0 };
  }

  private sweepExpiredLeases(now: number): void {
    this.db.prepare('DELETE FROM key_leases WHERE expires_at <= ?').run(now);
  }
}

function effectiveEnabled(row: RuntimeRow, candidate: SharedKeyCandidate): boolean {
  return candidate.configuredEnabled && row.enabled !== 0;
}

function evaluateQuota(usage: KeyUsage, quota: KeyQuotaConfig | null): {
  blocked: boolean;
  reason: string | null;
} {
  if (!quota) return { blocked: false, reason: null };
  const threshold = quota.soft_stop_threshold ?? 0.95;
  if (quota.max_requests != null && usage.requests_used >= quota.max_requests * threshold) {
    return { blocked: true, reason: '本地请求配额接近上限' };
  }
  if (quota.max_tokens != null && usage.tokens_used >= quota.max_tokens * threshold) {
    return { blocked: true, reason: '本地 token 配额接近上限' };
  }
  return { blocked: false, reason: null };
}

function normalizeErrorCategory(value: string | null): KeyErrorCategory {
  if (value === 'hard_limit' || value === 'rate_limit' || value === 'transient' || value === 'network') {
    return value;
  }
  return null;
}

function normalizeDelta(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function splitCompositeKey(compositeKey: string): { providerId: string; keyId: string } {
  const separator = compositeKey.indexOf(':');
  if (separator <= 0 || separator === compositeKey.length - 1) {
    throw new Error(`无效的 Key 复合 ID：${compositeKey}`);
  }
  return { providerId: compositeKey.slice(0, separator), keyId: compositeKey.slice(separator + 1) };
}

function minNullable(current: number | null, candidate: number): number {
  return current == null ? candidate : Math.min(current, candidate);
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
