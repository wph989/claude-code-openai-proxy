import { readFile } from 'node:fs/promises';
import type { KeyUsage } from '../models.js';
import { writeJsonAtomic } from '../utils/atomic-write.js';

export interface UsageStoreConfig {
  every_n: number;
  critical_threshold: number;
}

const PERSIST_VERSION = 2; // v2: 主键改为 providerId:id（不再用 key 字面量）

interface PersistShape {
  version?: number;
  updated_at?: number;
  usage?: Record<string, KeyUsage>;
}

/**
 * per-Key 配额计数持久化。主键格式：`${providerId}:${keyId}`（v2 起）。
 */
export class UsageStore {
  private data: Record<string, KeyUsage> = {};
  private dirtyCount = 0;
  private writing: Promise<void> | null = null;
  private pending = false;

  constructor(private filePath: string, private cfg: UsageStoreConfig) {}

  async load(): Promise<Record<string, KeyUsage>> {
    let legacy = false;
    try {
      const text = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(text) as PersistShape;
      // 只接受当前版本；v1 等旧格式直接丢弃（用户选择"全部重置"）。
      if (parsed?.version === PERSIST_VERSION && parsed.usage) {
        this.data = parsed.usage;
      } else {
        this.data = {};
        legacy = true; // 文件存在但格式过时：立刻覆盖成干净 v2。
      }
    } catch {
      this.data = {};
    }
    if (legacy) {
      await this.write();
    }
    return { ...this.data };
  }

  update(compositeKey: string, usage: KeyUsage, ratio: number): void {
    this.data[compositeKey] = { ...usage };
    this.dirtyCount += 1;
    const aggregateHit = this.dirtyCount >= this.cfg.every_n;
    const criticalHit = ratio >= this.cfg.critical_threshold;
    if (aggregateHit || criticalHit) this.schedule();
  }

  /**
   * 对齐当前期望的 key 集合：缺的补 0，多的删除。返回是否发生变更。
   */
  reconcile(desired: Set<string>): boolean {
    let changed = false;
    for (const k of Object.keys(this.data)) {
      if (!desired.has(k)) {
        delete this.data[k];
        changed = true;
      }
    }
    for (const k of desired) {
      if (!(k in this.data)) {
        this.data[k] = { requests_used: 0, tokens_used: 0 };
        changed = true;
      }
    }
    return changed;
  }

  async flushPending(): Promise<void> {
    if (this.writing) await this.writing;
  }

  async forceFlush(): Promise<void> {
    await this.write();
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    this.writing = this.write().finally(() => { this.pending = false; this.writing = null; });
  }

  private async write(): Promise<void> {
    const payload: PersistShape = {
      version: PERSIST_VERSION,
      updated_at: Math.floor(Date.now() / 1000),
      usage: this.data,
    };
    await writeJsonAtomic(this.filePath, payload);
    this.dirtyCount = 0;
  }
}
