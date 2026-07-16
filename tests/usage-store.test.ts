import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UsageStore } from '../src/services/usage-store.js';
import { writeJsonAtomic } from '../src/utils/atomic-write.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'usage-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('UsageStore', () => {
  it('returns empty when file missing', async () => {
    const s = new UsageStore(path.join(tmp, 'usage.json'), { every_n: 10, critical_threshold: 0.85 });
    const data = await s.load();
    expect(data).toEqual({});
  });

  it('persists after every_n recordUsage events', async () => {
    const file = path.join(tmp, 'usage.json');
    const s = new UsageStore(file, { every_n: 3, critical_threshold: 0.85 });
    await s.load();
    s.update('p:k1', { requests_used: 1, tokens_used: 0 }, 0);
    s.update('p:k1', { requests_used: 2, tokens_used: 0 }, 0);
    expect(existsSync(file)).toBe(false);
    s.update('p:k1', { requests_used: 3, tokens_used: 0 }, 0);
    await s.flushPending();
    expect(existsSync(file)).toBe(true);
    const json = JSON.parse(readFileSync(file, 'utf-8'));
    expect(json.usage['p:k1']).toEqual({ requests_used: 3, tokens_used: 0 });
  });

  it('persists immediately when ratio >= critical_threshold', async () => {
    const file = path.join(tmp, 'usage.json');
    const s = new UsageStore(file, { every_n: 999, critical_threshold: 0.85 });
    await s.load();
    s.update('p:k1', { requests_used: 90, tokens_used: 0 }, 0.90);
    await s.flushPending();
    expect(existsSync(file)).toBe(true);
  });

  it('forceFlush writes regardless of counters', async () => {
    const file = path.join(tmp, 'usage.json');
    const s = new UsageStore(file, { every_n: 999, critical_threshold: 0.99 });
    await s.load();
    s.update('p:k1', { requests_used: 1, tokens_used: 0 }, 0);
    await s.forceFlush();
    expect(existsSync(file)).toBe(true);
  });

  it('serializes concurrent forceFlush calls to avoid tmp-file races', async () => {
    const file = path.join(tmp, 'usage.json');
    const s = new UsageStore(file, { every_n: 999, critical_threshold: 0.99 });
    await s.load();
    s.update('p:k1', { requests_used: 1, tokens_used: 10 }, 0);

    await Promise.all(Array.from({ length: 20 }, () => s.forceFlush()));

    const json = JSON.parse(readFileSync(file, 'utf-8'));
    expect(json.usage['p:k1']).toEqual({ requests_used: 1, tokens_used: 10 });
  });

  it('writes a second snapshot when usage changes during an in-flight write', async () => {
    const file = path.join(tmp, 'usage.json');
    let releaseFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let writes = 0;
    const delayedWriter: typeof writeJsonAtomic = async (target, data) => {
      writes += 1;
      if (writes === 1) {
        notifyStarted();
        await firstWriteStarted;
      }
      await writeJsonAtomic(target, data);
    };
    const s = new UsageStore(file, { every_n: 1, critical_threshold: 0.85 }, delayedWriter);
    await s.load();

    s.update('p:k1', { requests_used: 1, tokens_used: 10 }, 0);
    await started;
    s.update('p:k1', { requests_used: 2, tokens_used: 20 }, 0);
    releaseFirstWrite();
    await s.flushPending();

    const json = JSON.parse(readFileSync(file, 'utf-8'));
    expect(writes).toBe(2);
    expect(json.usage['p:k1']).toEqual({ requests_used: 2, tokens_used: 20 });
  });

  it('load reads previously persisted data', async () => {
    const file = path.join(tmp, 'usage.json');
    const s1 = new UsageStore(file, { every_n: 1, critical_threshold: 0.85 });
    await s1.load();
    s1.update('p:k1', { requests_used: 5, tokens_used: 100 }, 0);
    await s1.flushPending();
    const s2 = new UsageStore(file, { every_n: 1, critical_threshold: 0.85 });
    const data = await s2.load();
    expect(data['p:k1']).toEqual({ requests_used: 5, tokens_used: 100 });
  });

  it('ignores legacy v1 file (treats as empty)', async () => {
    const file = path.join(tmp, 'usage.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      updated_at: 1700000000,
      usage: { 'p:sk-1': { requests_used: 100, tokens_used: 0 } }
    }), 'utf-8');
    const s = new UsageStore(file, { every_n: 1, critical_threshold: 0.85 });
    expect(await s.load()).toEqual({});
  });

  it('overwrites legacy v1 file with empty v2 on load', async () => {
    const file = path.join(tmp, 'usage.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      updated_at: 1700000000,
      usage: { 'p:sk-1': { requests_used: 100, tokens_used: 9999 } }
    }), 'utf-8');
    const s = new UsageStore(file, { every_n: 1, critical_threshold: 0.85 });
    await s.load();
    const after = JSON.parse(readFileSync(file, 'utf-8'));
    expect(after.version).toBe(2);
    expect(after.usage).toEqual({});
  });
});
