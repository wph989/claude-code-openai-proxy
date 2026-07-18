import { describe, expect, it } from 'vitest';
import { resolveClusterWorkerCount } from '../src/cluster.js';

describe('SQLite 集群 Worker 数量', () => {
  it('保留显式正整数 Worker 数量', () => {
    expect(resolveClusterWorkerCount(1)).toBe(1);
    expect(resolveClusterWorkerCount(2)).toBe(2);
    expect(resolveClusterWorkerCount(8)).toBe(8);
  });

  it('无效或非正数回退到单 Worker', () => {
    expect(resolveClusterWorkerCount(0)).toBe(1);
    expect(resolveClusterWorkerCount(-1)).toBe(1);
  });
});
