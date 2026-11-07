import type { BackgroundResultOriginMeta } from "@zcode/contracts";

import type { BackgroundRunRegistry } from "./watchdog/registry.js";

export type ChengJobTerminal = "completed" | "failed" | "cancelled";

/** 真实 ChengGate 结果最小结构；红 gate 在通知交付面静默丢弃。 */
export interface ChengJobGateVerdict {
  ok: boolean;
  level: "PRODUCTION" | "DIAGNOSTIC_NOT_ACCEPTANCE" | "BLOCKED";
  reasons: readonly string[];
}

/** 终态通知的唯一投递形状：claim 键 + 窄结果载荷。 */
export interface ChengJobNotification {
  commandId: string;
  jobId: string;
  taskId: string;
  text: string;
  originMeta: BackgroundResultOriginMeta;
}

/**
 * 会话账本端口（claim-first at-most-once）。claim 成功后才能 enqueue；已有同键行即跳过。
 * 生产实现见 `cheng-job-ledger.ts`（session_input + runtime task-notification）。
 */
export interface ChengJobNotificationLedger {
  hasClaim(commandId: string): Promise<boolean>;
  claim(commandId: string, notification: ChengJobNotification): Promise<void>;
  enqueue(notification: ChengJobNotification): Promise<void>;
}

export interface ChengJobRegistryOwnerOptions {
  readonly registry: BackgroundRunRegistry;
  /** 通知账本；daemon 启动对账可缺席（只标 failed，不投递）。 */
  readonly ledger?: ChengJobNotificationLedger;
  readonly now?: () => number;
}

export interface ChengJobReconcileOptions {
  /** 只处理超过该窗口未心跳的 running 行；daemon 启动默认 30s，测试可设 0。 */
  readonly staleAfterMs?: number;
  /** 只处理该会话拥有的行（会话 app 使用；daemon 不传 = 全局）。 */
  readonly ownerSession?: string;
  /** 固定时钟（测试）。 */
  readonly now?: number;
}

export type ChengJobSettlement =
  | "notified"
  | "already_claimed"
  | "gate_blocked"
  | "not_tracked"
  | "already_terminal";

/**
 * `kind=cheng-job` 的 owner 投影（S0）。
 *
 * 不变量：
 * - 行 owner 恒为 `cheng-host`；register/settle 都经 registry 的所有权检查。
 * - 终态只写一次：已在终态的行再次 settle 不重投通知。
 * - 通知 claim-first：先写 `cheng_<jobId>` 账本行，成功后才 enqueue；重启扫描遇到同键即跳过。
 * - 产出后红 gate：行仍写 completed，但 `terminalReason=cheng_gate_blocked`；不 claim/enqueue，
 *   重启补投按该 reason 跳过（结果静默丢弃，不是业务失败）。
 * - 重启对账把未完成 cheng-job 标 `failed`（绝不写 completed），且不为这些行发通知——
 *   进程死亡不是业务成功，也不制造“假 PASS”通知。
 */
export class ChengJobRegistryOwner {
  private readonly registry: BackgroundRunRegistry;
  private readonly ledger: ChengJobNotificationLedger | undefined;
  private readonly now: () => number;

  constructor(options: ChengJobRegistryOwnerOptions) {
    this.registry = options.registry;
    this.ledger = options.ledger;
    this.now = options.now ?? Date.now;
  }

  register(input: {
    jobId: string;
    ownerSession?: string;
    workspaceKey?: string;
    runId?: string;
  }): void {
    this.registry.register(
      {
        id: input.jobId,
        kind: "cheng-job",
        owner: "cheng-host",
        ...(input.ownerSession === undefined ? {} : { ownerSession: input.ownerSession }),
        ...(input.workspaceKey === undefined ? {} : { workspaceKey: input.workspaceKey }),
        ...(input.runId === undefined ? {} : { narrowResultRef: chengRunRef(input.runId) }),
        stallClockRef: `cheng-job:${input.jobId}`,
        heartbeat: true,
      },
      this.now(),
    );
  }

  touch(jobId: string, ownerSession?: string): void {
    this.registry.touch(jobId, "cheng-host", ownerSession === undefined ? {} : { ownerSession }, this.now());
  }

  async terminal(input: {
    jobId: string;
    state: ChengJobTerminal;
    runId?: string;
    gateLevel?: "DIAGNOSTIC_NOT_ACCEPTANCE" | "PRODUCTION";
    /**
     * 产出后的真实 ChengGate；`ok=false` 时静默丢弃该结果通知：settle 写
     * `terminalReason=cheng_gate_blocked`（重启补投跳过），不 claim、不 enqueue。
     */
    gate?: ChengJobGateVerdict;
  }): Promise<ChengJobSettlement> {
    const row = this.registry.get(input.jobId);
    if (row === undefined || row.kind !== "cheng-job") {
      return "not_tracked";
    }
    if (row.state !== "running") {
      return "already_terminal";
    }
    const gateBlocked = input.gate !== undefined && !input.gate.ok;
    this.registry.settle(
      input.jobId,
      "cheng-host",
      input.state,
      this.now(),
      {
        ...(input.runId === undefined ? {} : { narrowResultRef: chengRunRef(input.runId) }),
        ...(gateBlocked ? { terminalReason: "cheng_gate_blocked" } : {}),
      },
    );
    if (gateBlocked) return "gate_blocked";
    return await this.notify(input.jobId, input.state, input.runId, input.gateLevel);
  }

  /**
   * 进程重启后的对账。先 hydrate registry 再调用。
   * - running 且超过 stale 窗口（或指定 ownerSession）→ failed + `terminalReason=host_restarted`；
   *   该 reason 是持久抑制标记：daemon 无 runtime 也能安全对账，后续任何进程都不会为之补投。
   * - 已终态且未被抑制、通知未认领 → 补投一次（claim 键吸收重复）。
   */
  async reconcileAfterRestart(options: ChengJobReconcileOptions = {}): Promise<{
    failed: number;
    suppressed: number;
    notified: number;
    alreadyClaimed: number;
  }> {
    const { failed, suppressed } = this.reconcileRunningAfterRestart(options);
    let notified = 0;
    let alreadyClaimed = 0;
    for (const row of this.registry.list({ kind: "cheng-job" })) {
      if (
        row.state === "running" ||
        row.terminalReason === "host_restarted" ||
        row.terminalReason === "cheng_gate_blocked"
      ) {
        continue;
      }
      if (options.ownerSession !== undefined && row.ownerSession !== options.ownerSession) {
        continue;
      }
      if (row.state !== "completed" && row.state !== "failed" && row.state !== "cancelled") {
        continue;
      }
      const result = await this.notify(
        row.id,
        row.state,
        runIdFromRef(row.narrowResultRef),
        undefined,
      );
      if (result === "notified") notified += 1;
      else if (result === "already_claimed") alreadyClaimed += 1;
    }
    return { failed, suppressed, notified, alreadyClaimed };
  }

  /**
   * 只做“残留 running → failed + 抑制标记”，不需要账本/runtime。daemon 启动时调用；
   * `staleAfterMs` 只处理超过窗口未心跳的行，避免把其他仍存活进程的 job 误杀。
   */
  reconcileRunningAfterRestart(options: ChengJobReconcileOptions = {}): {
    failed: number;
    suppressed: number;
  } {
    const now = options.now ?? this.now();
    const staleAfterMs = options.staleAfterMs ?? 0;
    const ownerSession = options.ownerSession;
    let failed = 0;
    for (const row of this.registry.list({ kind: "cheng-job", state: "running" })) {
      if (ownerSession !== undefined && row.ownerSession !== ownerSession) {
        continue;
      }
      if (staleAfterMs > 0 && now - row.updatedAt < staleAfterMs) {
        continue;
      }
      this.registry.settle(row.id, "cheng-host", "failed", now, {
        terminalReason: "host_restarted",
      });
      failed += 1;
    }
    return { failed, suppressed: failed };
  }

  private async notify(
    jobId: string,
    state: ChengJobTerminal,
    runId: string | undefined,
    gateLevel: "DIAGNOSTIC_NOT_ACCEPTANCE" | "PRODUCTION" | undefined,
  ): Promise<ChengJobSettlement> {
    if (this.ledger === undefined) {
      throw new Error("Cheng notification ledger is not wired in this runtime");
    }
    const commandId = chengClaimId(jobId);
    if (await this.ledger.hasClaim(commandId)) {
      return "already_claimed";
    }
    const title = `Cheng job ${jobId} ${state}`;
    const notification: ChengJobNotification = {
      commandId,
      jobId,
      taskId: jobId,
      text: `${title}${runId === undefined ? "" : ` (run ${runId})`}`,
      originMeta: {
        backgroundSource: "cheng-job",
        workId: jobId,
        title,
        chengJob: {
          jobId,
          ...(runId === undefined ? {} : { runId }),
          ...(gateLevel === undefined ? {} : { gateLevel }),
        },
      },
    };
    await this.ledger.claim(commandId, notification);
    await this.ledger.enqueue(notification);
    return "notified";
  }
}

export function chengClaimId(jobId: string): string {
  return `cheng_${jobId}`;
}

function chengRunRef(runId: string): string {
  return `cheng-run://${runId}`;
}

function runIdFromRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  return ref.startsWith("cheng-run://") ? ref.slice("cheng-run://".length) : undefined;
}
