export interface KeySelector {
  pick(candidates: string[]): string | undefined;
  notifyKeyUnavailable(key: string): void;
  currentKey(): string | undefined;
}

export class StickySelector implements KeySelector {
  private activeKey: string | undefined = undefined;
  private avoidKey: string | undefined = undefined;

  pick(candidates: string[]): string | undefined {
    if (candidates.length === 0) return undefined;
    if (this.activeKey && candidates.includes(this.activeKey)) {
      return this.activeKey;
    }
    // 上一个 key 刚失败（网络/瞬时错误）：优先切到别的候选，避免继续咬住刚出错的链路。
    // 只有当没有其他候选时才退回到被规避的 key。规避标记是一次性的。
    const preferred = this.avoidKey ? candidates.find((k) => k !== this.avoidKey) : undefined;
    this.activeKey = preferred ?? candidates[0];
    this.avoidKey = undefined;
    return this.activeKey;
  }

  notifyKeyUnavailable(key: string): void {
    if (this.activeKey === key) {
      this.activeKey = undefined;
      this.avoidKey = key;
    }
  }

  currentKey(): string | undefined {
    return this.activeKey;
  }
}

export class BalancedSelector implements KeySelector {
  pick(candidates: string[]): string | undefined {
    if (candidates.length === 0) return undefined;
    // 简单的轮询：随机选择一个（已经过 eligibleKeys 过滤）
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  notifyKeyUnavailable(_key: string): void {
    // BalancedSelector 无内部状态需要清理
  }

  currentKey(): string | undefined {
    return undefined;
  }
}
