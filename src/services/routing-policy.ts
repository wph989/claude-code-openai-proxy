/** 可参与同名模型选择的最小路由字段。 */
export interface WeightedRouteCandidate {
  route: {
    priority?: number;
    weight?: number;
  };
}

/**
 * 同名模型路由策略：先取最小 priority，再按 weight 做加权选择。
 * 随机源由调用方注入，使边界值和分布测试不依赖概率。
 */
export class RoutingPolicy {
  constructor(private readonly randomSource: () => number = Math.random) {}

  select<T extends WeightedRouteCandidate>(candidates: T[]): T {
    if (candidates.length === 0) throw new Error('路由候选不能为空。');
    const highestPriority = Math.min(...candidates.map((candidate) => normalizeRoutePriority(candidate.route.priority)));
    const prioritized = candidates.filter(
      (candidate) => normalizeRoutePriority(candidate.route.priority) === highestPriority,
    );
    if (prioritized.length === 1) return prioritized[0];

    const weights = prioritized.map((candidate) => normalizeRouteWeight(candidate.route.weight));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const randomValue = normalizeRandom(this.randomSource());
    // 全部权重为 0 时仍均匀回退，避免一次错误配置让已有模型完全不可用。
    if (total <= 0) {
      return prioritized[Math.min(prioritized.length - 1, Math.floor(randomValue * prioritized.length))];
    }

    let cursor = randomValue * total;
    for (let index = 0; index < prioritized.length; index += 1) {
      cursor -= weights[index];
      if (cursor < 0) return prioritized[index];
    }
    return prioritized[prioritized.length - 1];
  }
}

export function normalizeRoutePriority(value: unknown): number {
  if (value == null || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1000, Math.trunc(parsed))) : 0;
}

export function normalizeRouteWeight(value: unknown): number {
  if (value == null || value === '') return 1;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100000, parsed)) : 1;
}

function normalizeRandom(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(0.999999999999, value)) : 0;
}
