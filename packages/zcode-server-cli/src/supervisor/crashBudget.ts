import { CRASH_BACKOFF_MS, CRASH_WINDOW_MS, type CrashBudgetSnapshot } from "../contracts.js";

export interface CrashBudgetOptions {
  now?: () => number;
  /** 测试/独立子进程可注入退避序列；生产缺省使用 Server CLI 的统一预算。 */
  backoffMs?: readonly number[];
  windowMs?: number;
}

export class CrashBudget {
  private windowStartedAt: number | undefined;
  private crashCount = 0;

  public constructor(private readonly options: CrashBudgetOptions = {}) {}

  private backoff(): readonly number[] {
    return this.options.backoffMs ?? CRASH_BACKOFF_MS;
  }

  public recordCrash(): { shouldRestart: boolean; delayMs: number; exhausted: boolean } {
    const now = this.options.now?.() ?? Date.now();
    const windowMs = this.options.windowMs ?? CRASH_WINDOW_MS;
    const backoff = this.backoff();
    if (this.windowStartedAt === undefined || now - this.windowStartedAt >= windowMs) {
      this.windowStartedAt = now;
      this.crashCount = 0;
    }
    const index = this.crashCount;
    this.crashCount += 1;
    const delayMs = backoff[Math.min(index, backoff.length - 1)] ?? 0;
    const exhausted = index >= backoff.length;
    return { shouldRestart: !exhausted, delayMs, exhausted };
  }

  public reset(): void {
    this.windowStartedAt = undefined;
    this.crashCount = 0;
  }

  public snapshot(): CrashBudgetSnapshot {
    const now = this.options.now?.() ?? Date.now();
    const windowMs = this.options.windowMs ?? CRASH_WINDOW_MS;
    const backoff = this.backoff();
    if (this.windowStartedAt !== undefined && now - this.windowStartedAt >= windowMs) {
      this.reset();
    }
    const nextRestartDelayMs =
      this.crashCount < backoff.length ? (backoff[this.crashCount] ?? 0) : 0;
    return {
      ...(this.windowStartedAt === undefined ? {} : { windowStartedAt: this.windowStartedAt }),
      crashCount: this.crashCount,
      nextRestartDelayMs,
      exhausted: this.crashCount > backoff.length,
    };
  }
}
