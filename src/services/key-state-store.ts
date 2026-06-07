import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../utils/atomic-write.js';

export interface KeyRuntimeRecord {
  enabled?: boolean;
  error_count?: number;
  disabled_at?: number | null;
  last_error_at?: number | null;
  last_error_message?: string | null;
  auto_disabled_at?: number | null;
}

interface PersistShape {
  version: number;
  updated_at: number;
  states: Record<string, KeyRuntimeRecord>;
}

const PERSIST_VERSION = 2; // v2: 主键改为 providerId:id（不再用 key 字面量）

/**
 * 程序运行时自动写入：error_count / disabled_at / last_error_* / auto_disabled_at / 自动禁用后的 enabled。
 * 与 runtime_models.json 解耦，避免每次 429 都改写用户配置文件。
 * 主键格式：`${providerId}:${keyId}`（v2 起改用稳定 id 而非 key 字面量）。
 */
export class KeyStateStore {
  private data: Record<string, KeyRuntimeRecord> = {};
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> | null = null;
  private readonly debounceMs: number;

  constructor(private readonly filePath: string, debounceMs = 500) {
    this.debounceMs = debounceMs;
  }

  async load(): Promise<Record<string, KeyRuntimeRecord>> {
    let legacy = false;
    try {
      const text = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(text) as Partial<PersistShape>;
      // 只接受当前版本；v1 等旧格式直接当空对象处理（用户选择"全部重置"）。
      if (parsed?.version === PERSIST_VERSION && parsed.states) {
        this.data = parsed.states;
      } else {
        this.data = {};
        legacy = true; // 文件存在但格式过时：立刻覆盖成干净 v2，避免肉眼误判仍是旧格式。
      }
    } catch {
      this.data = {};
    }
    if (legacy) {
      this.dirty = true;
      await this.write();
    }
    return { ...this.data };
  }

  get(compositeKey: string): KeyRuntimeRecord | undefined {
    const v = this.data[compositeKey];
    return v ? { ...v } : undefined;
  }

  snapshot(): Record<string, KeyRuntimeRecord> {
    return { ...this.data };
  }

  update(compositeKey: string, patch: KeyRuntimeRecord): void {
    const prior = this.data[compositeKey] ?? {};
    this.data[compositeKey] = { ...prior, ...patch };
    this.dirty = true;
    this.schedule();
  }

  bulkSet(records: Record<string, KeyRuntimeRecord>): void {
    let changed = false;
    for (const [key, value] of Object.entries(records)) {
      this.data[key] = { ...value };
      changed = true;
    }
    if (changed) {
      this.dirty = true;
      this.schedule();
    }
  }

  remove(compositeKey: string): void {
    if (compositeKey in this.data) {
      delete this.data[compositeKey];
      this.dirty = true;
      this.schedule();
    }
  }

  removeByProvider(providerId: string): void {
    const prefix = `${providerId}:`;
    let changed = false;
    for (const k of Object.keys(this.data)) {
      if (k.startsWith(prefix)) {
        delete this.data[k];
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.schedule();
    }
  }

  /**
   * 对齐当前期望的 key 集合：缺的补默认值，多的删除。返回是否发生变更。
   * 启动 / saveConfig / addKey 等场景调用，确保 state 文件总是反映当前 config 的全量。
   */
  reconcile(desired: Set<string>, defaults: KeyRuntimeRecord): boolean {
    let changed = false;
    for (const k of Object.keys(this.data)) {
      if (!desired.has(k)) {
        delete this.data[k];
        changed = true;
      }
    }
    for (const k of desired) {
      if (!(k in this.data)) {
        this.data[k] = { ...defaults };
        changed = true;
      }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  async forceFlush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.writing) await this.writing;
    if (!this.dirty) return;
    await this.write();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.debounceMs);
  }

  private async flushNow(): Promise<void> {
    if (this.writing) {
      await this.writing;
      if (!this.dirty) return;
    }
    this.writing = this.write().finally(() => {
      this.writing = null;
    });
    await this.writing;
  }

  private async write(): Promise<void> {
    const payload: PersistShape = {
      version: PERSIST_VERSION,
      updated_at: Math.floor(Date.now() / 1000),
      states: this.data
    };
    this.dirty = false;
    try {
      await writeJsonAtomic(this.filePath, payload);
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }
}
