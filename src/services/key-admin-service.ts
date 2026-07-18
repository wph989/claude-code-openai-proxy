import { RuntimeConfigError } from '../errors.js';
import type { ApiKeyEntry, KeyQuotaConfig } from '../types/runtime-config.js';
import type { AdminKeyView } from './admin-config.js';

export interface KeyAdminGateway {
  flushRuntimeStores(): Promise<void>;
  getAdminKeyStates(providerId: string): AdminKeyView[];
  exportKeys(providerId: string): string[];
  resetAllKeys(providerId: string): Promise<number>;
  addKeys(providerId: string, keyValues: string[]): Promise<{ added: string[]; skipped: string[] }>;
  enableKey(providerId: string, keyId: string): Promise<void>;
  disableKey(providerId: string, keyId: string): Promise<void>;
  resetKey(providerId: string, keyId: string): Promise<void>;
  updateKeyState(providerId: string, keyId: string, patch: Partial<ApiKeyEntry>): Promise<void>;
  deleteKey(providerId: string, keyId: string): Promise<void>;
  resetKeyQuota(providerId: string, keyId: string): Promise<void>;
  updateKeyQuota(
    providerId: string,
    keyId: string,
    quota: KeyQuotaConfig | null | undefined,
  ): Promise<void>;
}

export interface AddKeysResult {
  message: string;
  addedCount: number;
  skippedCount: number;
}

/**
 * Key 管理应用服务统一输入校验和秘密边界，路由层无需接触底层返回的 Key 字符串。
 * Gateway 保持窄接口，后续可把 RuntimeConfigManager 兼容门面替换为独立仓储实现。
 */
export class KeyAdminService {
  constructor(private readonly gateway: KeyAdminGateway) {}

  async listKeys(providerId: string): Promise<AdminKeyView[]> {
    await this.gateway.flushRuntimeStores();
    return this.gateway.getAdminKeyStates(providerId);
  }

  async exportKeys(providerId: string): Promise<string[]> {
    await this.gateway.flushRuntimeStores();
    return this.gateway.exportKeys(providerId);
  }

  async resetAllKeys(providerId: string): Promise<number> {
    return this.gateway.resetAllKeys(providerId);
  }

  async addKeys(providerId: string, input: unknown): Promise<AddKeysResult> {
    const body = toRecord(input);
    const values = body.keys ?? (body.key !== undefined ? [body.key] : []);
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string')) {
      throw new RuntimeConfigError('至少需要一个有效的 Key 字符串。');
    }

    const result = await this.gateway.addKeys(providerId, values);
    const addedCount = result.added.length;
    const skippedCount = result.skipped.length;
    return {
      message: buildAddMessage(addedCount, skippedCount),
      addedCount,
      skippedCount,
    };
  }

  async enableKey(providerId: string, keyId: string): Promise<void> {
    await this.gateway.enableKey(providerId, keyId);
  }

  async disableKey(providerId: string, keyId: string): Promise<void> {
    await this.gateway.disableKey(providerId, keyId);
  }

  async resetKey(providerId: string, keyId: string): Promise<void> {
    await this.gateway.resetKey(providerId, keyId);
  }

  async updateNote(providerId: string, keyId: string, input: unknown): Promise<void> {
    const note = String(toRecord(input).note ?? '').trim() || undefined;
    await this.gateway.updateKeyState(providerId, keyId, { note });
  }

  async deleteKey(providerId: string, keyId: string): Promise<void> {
    await this.gateway.deleteKey(providerId, keyId);
  }

  async resetQuota(providerId: string, keyId: string): Promise<void> {
    await this.gateway.resetKeyQuota(providerId, keyId);
  }

  async updateQuota(
    providerId: string,
    keyId: string,
    input: unknown,
  ): Promise<KeyQuotaConfig | null | undefined> {
    const quota = toRecord(input).quota as KeyQuotaConfig | null | undefined;
    validateQuota(quota);
    await this.gateway.updateKeyQuota(providerId, keyId, quota);
    return quota;
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function buildAddMessage(addedCount: number, skippedCount: number): string {
  if (addedCount === 0 && skippedCount === 0) return '没有有效的 Key 值';
  const parts: string[] = [];
  if (addedCount > 0) parts.push(`新增 ${addedCount} 个`);
  if (skippedCount > 0) parts.push(`跳过 ${skippedCount} 个（已存在）`);
  return `添加完成：${parts.join('，')}`;
}

function validateQuota(quota: KeyQuotaConfig | null | undefined): void {
  if (quota === null || quota === undefined) return;
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) {
    throw new RuntimeConfigError('quota 必须是对象、null 或省略。');
  }
  if (quota.soft_stop_threshold !== undefined
    && (typeof quota.soft_stop_threshold !== 'number' || quota.soft_stop_threshold <= 0 || quota.soft_stop_threshold > 1)) {
    throw new RuntimeConfigError('soft_stop_threshold 必须在 (0, 1] 之间。');
  }
  if (quota.max_requests != null && (typeof quota.max_requests !== 'number' || quota.max_requests <= 0)) {
    throw new RuntimeConfigError('max_requests 必须为正数或 null。');
  }
  if (quota.max_tokens != null && (typeof quota.max_tokens !== 'number' || quota.max_tokens <= 0)) {
    throw new RuntimeConfigError('max_tokens 必须为正数或 null。');
  }
  for (const field of ['max_cost_usd', 'input_cost_per_million', 'output_cost_per_million'] as const) {
    const value = quota[field];
    if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      throw new RuntimeConfigError(`${field} 必须为正数或 null。`);
    }
  }
}
