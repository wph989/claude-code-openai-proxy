import { describe, expect, it, vi } from 'vitest';
import {
  normalizeRoutePriority,
  normalizeRouteWeight,
  RoutingPolicy,
} from '../src/services/routing-policy.js';

describe('RoutingPolicy', () => {
  it('始终先选择数值最小的优先级', () => {
    const random = vi.fn(() => 0.99);
    const selected = new RoutingPolicy(random).select([
      candidate('backup', 10, 1000),
      candidate('primary', 0, 1),
      candidate('secondary', 5, 1000),
    ]);

    expect(selected.id).toBe('primary');
    // 只剩一个最高优先级候选时不消耗随机源，便于确定性故障转移。
    expect(random).not.toHaveBeenCalled();
  });

  it('按同优先级权重的边界选择候选', () => {
    const candidates = [candidate('a', 0, 1), candidate('b', 0, 3)];

    expect(new RoutingPolicy(() => 0).select(candidates).id).toBe('a');
    expect(new RoutingPolicy(() => 0.249999).select(candidates).id).toBe('a');
    expect(new RoutingPolicy(() => 0.25).select(candidates).id).toBe('b');
    expect(new RoutingPolicy(() => 1).select(candidates).id).toBe('b');
  });

  it('全部权重为零时使用均匀回退，非法随机值归一到零', () => {
    const candidates = [candidate('a', 0, 0), candidate('b', 0, 0)];

    expect(new RoutingPolicy(() => Number.NaN).select(candidates).id).toBe('a');
    expect(new RoutingPolicy(() => 0.75).select(candidates).id).toBe('b');
  });

  it('标准化优先级和权重的默认值及范围', () => {
    expect(normalizeRoutePriority(undefined)).toBe(0);
    expect(normalizeRoutePriority(-1)).toBe(0);
    expect(normalizeRoutePriority(12.9)).toBe(12);
    expect(normalizeRoutePriority(5000)).toBe(1000);
    expect(normalizeRouteWeight(undefined)).toBe(1);
    expect(normalizeRouteWeight(-1)).toBe(0);
    expect(normalizeRouteWeight(2.5)).toBe(2.5);
    expect(normalizeRouteWeight(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('空候选给出稳定错误', () => {
    expect(() => new RoutingPolicy().select([])).toThrow('路由候选不能为空。');
  });
});

function candidate(id: string, priority: number, weight: number) {
  return { id, route: { priority, weight } };
}
