import { readFile } from 'node:fs/promises';
import type { KeyUsage } from '../models.js';
import { writeJsonAtomic } from '../utils/atomic-write.js';

export interface UsageStoreConfig {
  every_n: number;
  critical_threshold: number;
}

type JsonWriter = typeof writeJsonAtomic;

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
  private mutationVersion = 0;
  private persistedVersion = 0;
  private writing: Promise<void> | null = null;
  private pending = false;

  constructor(
    private filePath: string,
    private cfg: UsageStoreConfig,
    private readonly writer: JsonWriter = writeJsonAtomic
  ) {}

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
    this.mutationVersion += 1;
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
    if (changed) {
      this.dirtyCount += 1;
      this.mutationVersion += 1;
    }
    return changed;
  }

  async flushPending(): Promise<void> {
    // 写入完成回调可能因为期间出现新用量而追加一轮，因此需要一直等到队列真正清空。
    while (this.writing) await this.writing;
  }

  async forceFlush(): Promise<void> {
    await this.queueWrite();
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    void this.queueWrite().catch((err) => {
      // 后台批量写入没有直接调用方；记录错误并保留 dirty 状态，后续更新或 shutdown 会再次尝试。
      console.error('[usage] 持久化配额用量失败:', err);
    });
  }

  private queueWrite(): Promise<void> {
    const previous = this.writing;
    let succeeded = false;
    const queued = (previous ? previous.catch(() => {}) : Promise.resolve()).then(async () => {
      await this.write();
      succeeded = true;
    });
    const tracked = queued.finally(() => {
      if (this.writing === tracked) {
        this.pending = false;
        this.writing = null;
        if (succeeded && this.persistedVersion !== this.mutationVersion) {
          // 快照写入期间又收到新用量时立即补写，避免临界配额只停留在内存中。
          this.schedule();
        }
      }
    });
    // 所有强制刷新和批量刷新必须串行，否则多个 writer 会抢同一个 .tmp 文件。
    this.writing = tracked;
    return tracked;
  }

  private async write(): Promise<void> {
    const versionAtStart = this.mutationVersion;
    const dirtyAtStart = this.dirtyCount;
    const payload: PersistShape = {
      version: PERSIST_VERSION,
      updated_at: Math.floor(Date.now() / 1000),
      // 写入固定快照，才能准确判断 await 期间发生的更新是否需要追加一轮。
      usage: Object.fromEntries(Object.entries(this.data).map(([key, usage]) => [key, { ...usage }])),
    };
    await this.writer(this.filePath, payload);
    this.persistedVersion = versionAtStart;
    this.dirtyCount = Math.max(0, this.dirtyCount - dirtyAtStart);
  }
}
