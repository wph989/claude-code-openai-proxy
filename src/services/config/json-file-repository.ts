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
import type { ConfigRepository, UsageStoreInitOptions } from './repository.js';

export class JsonFileConfigRepository implements ConfigRepository {
  private readonly configPath: string;
  private readonly stateFilePath: string;

  constructor(configPath: string) {
    this.configPath = path.resolve(configPath);
    // 运行态文件固定与主配置同目录，方便用户备份或清空所有 ccop 状态
    this.stateFilePath = path.resolve(path.dirname(this.configPath), 'runtime_state.json');
  }

  async loadConfig(): Promise<RuntimeConfig> {
    const text = await readFile(this.configPath, 'utf-8');
    return JSON.parse(text) as RuntimeConfig;
  }

  async saveConfig(config: RuntimeConfig): Promise<void> {
    await writeJsonAtomic(this.configPath, config);
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
}
