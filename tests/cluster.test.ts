import { describe, expect, it } from 'vitest';
import { assertClusterWorkerCount, resolveClusterWorkerCount } from '../src/cluster.js';

describe('集群安全限制', () => {
  it('允许单 Worker 兼容模式', () => {
    expect(() => assertClusterWorkerCount(1)).not.toThrow();
    expect(resolveClusterWorkerCount(1)).toBe(1);
    expect(resolveClusterWorkerCount(0)).toBe(1);
  });

  it('拒绝会破坏本地状态一致性的多 Worker', () => {
    expect(() => assertClusterWorkerCount(2)).toThrow('不支持多 Worker 集群');
  });
});
