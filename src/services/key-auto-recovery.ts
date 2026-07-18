import type { ApiKeyEntry } from '../types/runtime-config.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 只负责“何时恢复”，不负责“如何恢复”。状态转换由调用方回调完成，
 * 这样定时器生命周期与 Key 健康规则可以分别测试和演进。
 */
export class KeyAutoRecoveryScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly keys: ApiKeyEntry[],
    private readonly recoverAfterMs: number,
    private readonly recover: (key: string) => void,
  ) {}

  recoverExpired(now: number): void {
    if (this.recoverAfterMs <= 0) return;
    for (const entry of this.keys) {
      if (entry.enabled || entry.auto_disabled_at == null) continue;
      if (now - entry.auto_disabled_at < this.recoverAfterMs) continue;
      this.recover(entry.key);
    }
  }

  schedule(): void {
    this.clearTimer();
    if (this.recoverAfterMs <= 0) return;

    let nextRecoveryAt: number | null = null;
    for (const entry of this.keys) {
      if (entry.enabled || entry.auto_disabled_at == null) continue;
      const recoveryAt = entry.auto_disabled_at + this.recoverAfterMs;
      nextRecoveryAt = nextRecoveryAt == null ? recoveryAt : Math.min(nextRecoveryAt, recoveryAt);
    }
    if (nextRecoveryAt == null) return;

    // Node 的 setTimeout 最长约 24.8 天；更长的窗口分段唤醒，避免整数溢出后立即恢复。
    const delay = Math.min(Math.max(0, nextRecoveryAt - Date.now()), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.recoverExpired(Date.now());
      this.schedule();
    }, delay);
    // 后台恢复不能单独阻止服务正常退出。
    this.timer.unref?.();
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
