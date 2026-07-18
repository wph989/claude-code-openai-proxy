/**
 * 运行时配置仓库抽象。
 *
 * 把配置、运行态和用量的语义从 SQLite 表结构中抽出来，
 * 让应用服务不直接依赖 SQL 语句。生产运行时只有 SQLite 实现；旧 JSON 仅由迁移器读取。
 */

import type { KeyRuntimeRecord, KeyUsage, RuntimeConfig } from '../../types/runtime-config.js';
import type { KeyRuntimeCoordinator } from '../key-runtime-coordinator.js';
import type { ProviderCircuitCoordinator } from '../provider-circuit-coordinator.js';

export interface ConfigHistoryRecord {
  revision: number;
  createdAt: number;
  config: RuntimeConfig;
}

/** SQLite key_states 表的应用端口。 */
export interface KeyStateRepository {
  load(): Promise<Record<string, KeyRuntimeRecord>>;
  get(compositeKey: string): KeyRuntimeRecord | undefined;
  snapshot(): Record<string, KeyRuntimeRecord>;
  update(compositeKey: string, patch: KeyRuntimeRecord): void;
  bulkSet(records: Record<string, KeyRuntimeRecord>): void;
  remove(compositeKey: string): void;
  removeByProvider(providerId: string): void;
  reconcile(desired: Set<string>, defaults: KeyRuntimeRecord): boolean;
  forceFlush(): Promise<void>;
}

/** SQLite key_usage 表的应用端口；跨 Worker 原子增量由共享协调器负责。 */
export interface UsageRepository {
  load(): Promise<Record<string, KeyUsage>>;
  update(compositeKey: string, usage: KeyUsage, ratio: number): void;
  reconcile(desired: Set<string>): boolean;
  forceFlush(): Promise<void>;
}

export interface ConfigRepository {
  /**
   * 加载 SQLite 中的当前配置。
   * 配置行尚未初始化或内容无法解析时抛错，由调用方决定是否触发 ensureDefault。
   */
  loadConfig(): Promise<RuntimeConfig>;

  /** 持久化主配置；运行态字段必须先剥离，避免混入配置历史。 */
  saveConfig(config: RuntimeConfig, expectedRevision?: number): Promise<void>;

  /** 低成本读取持久化 revision，用于多 Worker 请求前刷新配置。 */
  getConfigRevision?(): Promise<number | null>;

  /**
   * 在 SQLite 中尚未初始化配置时创建默认配置。
   */
  ensureDefaultConfig(buildDefault: () => RuntimeConfig): Promise<RuntimeConfig>;

  /**
   * 创建 Key 运行态存储（error_count、disabled_at、last_error_* 等）。
   * 多次调用应访问同一份 SQLite 数据。
   */
  createKeyStateStore(): KeyStateRepository;

  /**
   * 创建 Key 配额计数存储。
   */
  createUsageStore(): UsageRepository;

  /**
   * 创建跨 Worker Key 运行态协调器，并复用当前 SQLite 连接。
   */
  createKeyRuntimeCoordinator?(): KeyRuntimeCoordinator;

  /** 创建跨 Worker Provider 熔断协调器；只有事务后端应实现。 */
  createProviderCircuitCoordinator?(): ProviderCircuitCoordinator;

  /** 历史快照只供服务端回滚使用，路由层不得直接序列化其中的 config。 */
  listConfigHistory?(limit: number): Promise<ConfigHistoryRecord[]>;
  loadConfigHistory?(revision: number): Promise<ConfigHistoryRecord | null>;

  /** 释放数据库连接。 */
  close?(): Promise<void> | void;
}
