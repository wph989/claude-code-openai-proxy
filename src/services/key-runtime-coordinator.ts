import type { KeyErrorCategory } from './api-key-rotator.js';
import type { KeyQuotaConfig, KeyUsage } from '../types/runtime-config.js';

export interface SharedKeyCandidate {
  compositeKey: string;
  configuredEnabled: boolean;
  maxConcurrent: number;
  minIntervalMs: number;
  autoRecoverMs: number;
  quota: KeyQuotaConfig | null;
}

export interface SharedKeyLease {
  leaseId: string;
  compositeKey: string;
  expiresAt: number;
}

export interface SharedKeySnapshot {
  enabled: boolean;
  errorCount: number;
  disabledAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  autoDisabledAt: number | null;
  nextAvailableAt: number | null;
  lastSentAt: number | null;
  lastErrorCategory: KeyErrorCategory;
  activeLeases: number;
  usage: KeyUsage;
  quotaBlocked: boolean;
  quotaReason: string | null;
}

export interface SharedAcquireResult {
  lease: SharedKeyLease | null;
  snapshot: SharedKeySnapshot | null;
  hasPotentialCandidate: boolean;
  nextAvailableAt: number | null;
}

export interface SharedFailureOptions {
  now: number;
  message: string;
  category: Exclude<KeyErrorCategory, null>;
  autoDisable: boolean;
  maxErrors: number;
}

/**
 * 跨 Worker Key 运行态端口。所有方法同步完成事务后返回，调用方不会观察到尚未提交的 lease/计数。
 */
export interface KeyRuntimeCoordinator {
  tryAcquire(candidates: SharedKeyCandidate[], now: number, leaseTtlMs: number): SharedAcquireResult;
  release(leaseId: string): void;
  markError(candidate: SharedKeyCandidate, options: SharedFailureOptions): SharedKeySnapshot;
  markQuotaError(candidate: SharedKeyCandidate, options: SharedFailureOptions): SharedKeySnapshot;
  markRateLimited(
    candidate: SharedKeyCandidate,
    options: SharedFailureOptions & { delayMs: number },
  ): SharedKeySnapshot;
  markSuccess(candidate: SharedKeyCandidate, now: number): SharedKeySnapshot;
  setEnabled(candidate: SharedKeyCandidate, enabled: boolean, now: number, reason?: string): SharedKeySnapshot;
  reset(candidate: SharedKeyCandidate, now: number): SharedKeySnapshot;
  recordUsage(candidate: SharedKeyCandidate, requests: number, tokens: number, now: number): SharedKeySnapshot;
  resetUsage(candidate: SharedKeyCandidate, now: number): SharedKeySnapshot;
  snapshot(candidate: SharedKeyCandidate, now: number): SharedKeySnapshot;
}
