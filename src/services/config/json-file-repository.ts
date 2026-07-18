/**
 * ConfigRepository 的 JSON 文件实现：
 *   - 主配置文件：runtime_models.json（由用户配置，路径来自构造参数）
 *   - 运行态文件：runtime_state.json（与主配置同目录）
 *   - 用量文件：runtime_usage.json（由 anti_ban.quota.usage_file 决定，默认与主配置同目录）
 *
 * 写入使用 utils/atomic-write 的 .tmp + rename 保证原子性。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../../utils/atomic-write.js';
import { KeyStateStore } from '../key-state-store.js';
import { UsageStore } from '../usage-store.js';
import type { RuntimeConfig } from '../../types/runtime-config.js';
import type { ConfigHistoryRecord, ConfigRepository, UsageStoreInitOptions } from './repository.js';

interface HistoryFileShape {
  version: 1;
  entries: ConfigHistoryRecord[];
}

export class JsonFileConfigRepository implements ConfigRepository {
  readonly storageKind = 'json' as const;
  readonly supportsSharedRuntime = false;
  private readonly configPath: string;
  private readonly stateFilePath: string;
  private readonly historyFilePath: string;

  constructor(configPath: string) {
    this.configPath = path.resolve(configPath);
    // 运行态文件固定与主配置同目录，方便用户备份或清空所有 ccop 状态
    this.stateFilePath = path.resolve(path.dirname(this.configPath), 'runtime_state.json');
    this.historyFilePath = path.resolve(path.dirname(this.configPath), 'runtime_history.json');
  }

  async loadConfig(): Promise<RuntimeConfig> {
    const text = await readFile(this.configPath, 'utf-8');
    const config = JSON.parse(text) as RuntimeConfig;
    await this.recordHistorySafely(config, false);
    return config;
  }

  async saveConfig(config: RuntimeConfig): Promise<void> {
    await writeJsonAtomic(this.configPath, config);
    await this.recordHistorySafely(config, true);
  }

  async getConfigRevision(): Promise<number | null> {
    try {
      const config = await this.loadConfig();
      const revision = Number(config.revision);
      return Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
    } catch {
      return null;
    }
  }

  async ensureDefaultConfig(buildDefault: () => RuntimeConfig): Promise<RuntimeConfig> {
    const dir = path.dirname(this.configPath);
    await mkdir(dir, { recursive: true });
    const config = buildDefault();
    await writeFile(
      this.configPath,
      JSON.stringify(config, null, 2) + '\n',
      'utf-8'
    );
    await this.recordHistorySafely(config, true);
    console.log(`[init] 配置文件已创建: ${this.configPath}`);
    return config;
  }

  createKeyStateStore(): KeyStateStore {
    return new KeyStateStore(this.stateFilePath);
  }

  createUsageStore(options: UsageStoreInitOptions): UsageStore {
    const usageFile = path.isAbsolute(options.usageFileHint)
      ? options.usageFileHint
      : path.resolve(path.dirname(this.configPath), options.usageFileHint);
    return new UsageStore(usageFile, {
      every_n: options.every_n,
      critical_threshold: options.critical_threshold
    });
  }

  async listConfigHistory(limit: number): Promise<ConfigHistoryRecord[]> {
    const history = await this.loadHistoryFile();
    return history.entries
      .slice()
      .sort((left, right) => right.revision - left.revision)
      .slice(0, normalizeHistoryLimit(limit))
      .map((entry) => structuredClone(entry));
  }

  async loadConfigHistory(revision: number): Promise<ConfigHistoryRecord | null> {
    const history = await this.loadHistoryFile();
    const entry = history.entries.find((item) => item.revision === revision);
    return entry ? structuredClone(entry) : null;
  }

  private async appendHistory(config: RuntimeConfig, replaceExisting: boolean): Promise<void> {
    const revision = normalizeRevision(config.revision);
    const history = await this.loadHistoryFile();
    const existing = history.entries.find((item) => item.revision === revision);
    if (existing && !replaceExisting) return;
    const entry: ConfigHistoryRecord = {
      revision,
      createdAt: replaceExisting || !existing ? Date.now() : existing.createdAt,
      config: structuredClone(config),
    };
    const entries = [entry, ...history.entries.filter((item) => item.revision !== revision)]
      .sort((left, right) => right.revision - left.revision)
      .slice(0, 50);
    await writeJsonAtomic(this.historyFilePath, { version: 1, entries } satisfies HistoryFileShape);
  }

  private async recordHistorySafely(config: RuntimeConfig, replaceExisting: boolean): Promise<void> {
    try {
      await this.appendHistory(config, replaceExisting);
    } catch (error) {
      // 历史是恢复辅助，失败不能让已原子写入的主配置被误判为保存失败。
      console.error('[config] 配置历史写入失败:', error instanceof Error ? error.message : String(error));
    }
  }

  private async loadHistoryFile(): Promise<HistoryFileShape> {
    try {
      const parsed = JSON.parse(await readFile(this.historyFilePath, 'utf-8')) as Partial<HistoryFileShape>;
      if (parsed.version === 1 && Array.isArray(parsed.entries)) {
        return { version: 1, entries: parsed.entries };
      }
    } catch {
      // 历史缺失或损坏不应阻止主配置启动；下一次成功保存会重建有效文件。
    }
    return { version: 1, entries: [] };
  }
}

function normalizeHistoryLimit(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 50) : 20;
}

function normalizeRevision(value: unknown): number {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
}
