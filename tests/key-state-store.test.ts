import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KeyStateStore } from '../src/services/key-state-store.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), 'keystate-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('KeyStateStore', () => {
  it('returns empty when file missing', async () => {
    const s = new KeyStateStore(path.join(tmp, 'state.json'));
    expect(await s.load()).toEqual({});
  });

  it('persists update after debounce', async () => {
    const file = path.join(tmp, 'state.json');
    const s = new KeyStateStore(file, 20);
    await s.load();
    s.update('p:k1', { error_count: 3, last_error_at: 1700000000000 });
    expect(existsSync(file)).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    await s.forceFlush();
    const json = JSON.parse(readFileSync(file, 'utf-8'));
    expect(json.states['p:k1']).toMatchObject({ error_count: 3, last_error_at: 1700000000000 });
  });

  it('forceFlush writes immediately', async () => {
    const file = path.join(tmp, 'state.json');
    const s = new KeyStateStore(file, 5000);
    await s.load();
    s.update('p:k1', { error_count: 1 });
    await s.forceFlush();
    expect(existsSync(file)).toBe(true);
  });

  it('serializes forceFlush calls when new state arrives while a write is in flight', async () => {
    const file = path.join(tmp, 'state.json');
    const s = new KeyStateStore(file, 5000);
    await s.load();
    for (let i = 0; i < 5000; i++) {
      s.update(`p:seed-${i}`, { error_count: i });
    }

    const first = s.forceFlush();
    await Promise.resolve();
    s.update('p:k1', { error_count: 1, last_error_message: 'quota exceeded' });
    await Promise.all([first, s.forceFlush()]);

    const json = JSON.parse(readFileSync(file, 'utf-8'));
    expect(json.states['p:k1']).toEqual({ error_count: 1, last_error_message: 'quota exceeded' });
  });

  it('reads previously persisted records', async () => {
    const file = path.join(tmp, 'state.json');
    const s1 = new KeyStateStore(file, 0);
    await s1.load();
    s1.update('p:k1', { error_count: 5, last_error_message: 'x' });
    await s1.forceFlush();
    const s2 = new KeyStateStore(file);
    const data = await s2.load();
    expect(data['p:k1']).toEqual({ error_count: 5, last_error_message: 'x' });
  });

  it('ignores legacy v1 file (treats as empty)', async () => {
    const file = path.join(tmp, 'state.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      updated_at: 1700000000,
      states: { 'p:sk-1': { error_count: 9 } }
    }), 'utf-8');
    const s = new KeyStateStore(file);
    expect(await s.load()).toEqual({});
  });

  it('overwrites legacy v1 file with empty v2 on load', async () => {
    const file = path.join(tmp, 'state.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      updated_at: 1700000000,
      states: { 'p:sk-1': { error_count: 9, last_error_message: 'old' } }
    }), 'utf-8');
    const s = new KeyStateStore(file);
    await s.load();
    const after = JSON.parse(readFileSync(file, 'utf-8'));
    expect(after.version).toBe(2);
    expect(after.states).toEqual({});
  });

  it('remove deletes a record', async () => {
    const file = path.join(tmp, 'state.json');
    const s = new KeyStateStore(file, 0);
    await s.load();
    s.update('p:k1', { error_count: 2 });
    await s.forceFlush();
    s.remove('p:k1');
    await s.forceFlush();
    const json = JSON.parse(readFileSync(file, 'utf-8'));
    expect(json.states['p:k1']).toBeUndefined();
  });

  it('removeByProvider clears all keys under a provider', async () => {
    const file = path.join(tmp, 'state.json');
    const s = new KeyStateStore(file, 0);
    await s.load();
    s.update('p1:k1', { error_count: 1 });
    s.update('p1:k2', { error_count: 1 });
    s.update('p2:k1', { error_count: 1 });
    await s.forceFlush();
    s.removeByProvider('p1');
    await s.forceFlush();
    const json = JSON.parse(readFileSync(file, 'utf-8'));
    expect(json.states['p1:k1']).toBeUndefined();
    expect(json.states['p1:k2']).toBeUndefined();
    expect(json.states['p2:k1']).toEqual({ error_count: 1 });
  });

  it('bulkSet merges multiple records', async () => {
    const file = path.join(tmp, 'state.json');
    const s = new KeyStateStore(file, 0);
    await s.load();
    s.bulkSet({
      'p:k1': { error_count: 1 },
      'p:k2': { error_count: 2, auto_disabled_at: 1700000000000 }
    });
    await s.forceFlush();
    const json = JSON.parse(readFileSync(file, 'utf-8'));
    expect(json.states['p:k1']).toEqual({ error_count: 1 });
    expect(json.states['p:k2']).toEqual({ error_count: 2, auto_disabled_at: 1700000000000 });
  });

  it('reconcile fills missing keys with defaults and removes stale ones', async () => {
    const file = path.join(tmp, 'state.json');
    const s = new KeyStateStore(file, 0);
    await s.load();
    s.update('p:k1', { error_count: 5 });
    await s.forceFlush();
    const defaults = { error_count: 0, disabled_at: null, last_error_at: null, last_error_message: null, auto_disabled_at: null };
    const changed = s.reconcile(new Set(['p:k2', 'p:k3']), defaults);
    expect(changed).toBe(true);
    await s.forceFlush();
    const json = JSON.parse(readFileSync(file, 'utf-8'));
    expect(json.states['p:k1']).toBeUndefined();
    expect(json.states['p:k2']).toEqual(defaults);
    expect(json.states['p:k3']).toEqual(defaults);
  });
});
