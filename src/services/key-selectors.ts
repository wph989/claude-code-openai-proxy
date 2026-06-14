export interface KeySelector {
  pick(candidates: string[]): string | undefined;
  notifyKeyUnavailable(key: string): void;
  currentKey(): string | undefined;
}

export class StickySelector implements KeySelector {
  private activeKey: string | undefined = undefined;

  pick(candidates: string[]): string | undefined {
    if (candidates.length === 0) return undefined;
    if (this.activeKey && candidates.includes(this.activeKey)) {
      return this.activeKey;
    }
    // 简单选择第一个可用 Key（已经过 eligibleKeys 过滤）
    this.activeKey = candidates[0];
    return this.activeKey;
  }

  notifyKeyUnavailable(key: string): void {
    if (this.activeKey === key) {
      this.activeKey = undefined;
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
