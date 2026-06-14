/**
 * 运行时配置仓库抽象。
 *
 * 把"配置 + 运行态 + 用量"三类数据的物理存储后端从 RuntimeConfigManager 中抽出来，
 * 让上层只关心数据语义、不关心数据是放在 JSON 文件、SQLite 还是远程 KV 里。
 *
 * 当前默认实现：JsonFileConfigRepository（见 json-file-repository.ts），
 * 三类数据分别落在 runtime_models.json / runtime_state.json / runtime_usage.json。
 *
 * 未来若引入 SQLite：新增 SqliteConfigRepository 实现本接口即可，RuntimeConfigManager
 * 与所有调用方均无需改动。
 */

import type { RuntimeConfig } from '../../types/runtime-config.js';
import type { KeyStateStore } from '../key-state-store.js';
import type { UsageStore } from '../usage-store.js';

export interface UsageStoreInitOptions {
  every_n: number;
  critical_threshold: number;
  /**
   * 用户在 anti_ban.quota.usage_file 中配置的文件名 / 路径。
   * 当为相对路径时，仓库实现负责把它解析成实际位置（例如 JSON 实现会相对于
   * 配置文件目录解析；SQLite 实现可以忽略这个字段）。
   */
  usageFileHint: string;
}

export interface ConfigRepository {
  /**
   * 加载主配置文件（runtime_models.json 等价物）。
   * 文件不存在或解析失败时抛错，由调用方决定是否触发 ensureDefault。
   */
  loadConfig(): Promise<RuntimeConfig>;

  /**
   * 持久化主配置。已剥离运行态字段（由 stripRuntimeFromConfig 处理）。
   */
  saveConfig(config: RuntimeConfig): Promise<void>;

  /**
   * 在主配置缺失时创建默认配置文件。返回写入的 RuntimeConfig 以便调用方继续 reload。
   */
  ensureDefaultConfig(buildDefault: () => RuntimeConfig): Promise<RuntimeConfig>;

  /**
   * 创建 Key 运行态存储（error_count、disabled_at、last_error_* 等）。
   * 多次调用应返回同一份后端数据；JSON 实现会每次 new 一个 store 但指向同一文件。
   */
  createKeyStateStore(): KeyStateStore;

  /**
   * 创建 Key 配额计数存储。usageFileHint 来自 anti_ban.quota.usage_file 配置。
   */
  createUsageStore(options: UsageStoreInitOptions): UsageStore;
}
