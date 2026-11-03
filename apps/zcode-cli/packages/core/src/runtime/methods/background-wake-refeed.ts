import type {
  BackgroundResultOriginMeta,
  DynamicWorkflowRunSnapshot,
  SessionInputRecord,
} from "@zcode/contracts";
import { traceContextToLogContext, type TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  enqueueBackgroundTaskNotification,
  persistBackgroundTaskNotificationClaim,
} from "./background-notifications.js";

/**
 * 终态唤醒再投喂（spec: docs/architecture/super-agent-wake-refeed-spec.md，设计 M7①）。
 *
 * 冷 resume 的 sweep（discardPersistedPendingSteerInputs）把残留 admitted 的 wake 收口为
 * discarded(session_resumed)——可追责不可恢复：进程死亡时已终态的 workflow run，其窄结果
 * 通知永不投递。这里在 sweep 之后扫描账本，把**主体仍存活**（journal 可判别为可恢复终态）
 * 的 terminal 窄结果 wake 幂等重投；死 Bash / 死 subagent / 非终态提醒维持丢弃、保留审计。
 *
 * 读法（对设计原文「从 registry/journal 把已终态未消费的窄结果重新 enqueue」的显式收敛，
 * 见 spec §2）：**账本驱动 + journal 校验**——候选集只来自账本 discarded(session_resumed)
 * 行（「曾被 wake 且未消费」的事实来源），journal 仅判主体可恢复性。纯 journal 枚举分不清
 * policy 抑制 / TaskOutput 已消费 / 从未 wake，会错投；无账本行的终态 run 不在本扫描覆盖面。
 *
 * 幂等键 `refeed_<taskId>` 派生自稳定 runId（session_input.id 全局唯一）：账本存在该键的
 * 行（任意状态）即 claim 成功、跳过——saveSessionInput upsert 不复位 status、settle/promote
 * 只认 admitted，键行不可复活，故语义是 at-most-once（宁可窄窗口不丢失，不可双投）。claim
 * 行由 claim 路径先落库、确认成功后才入队（见 enqueueBackgroundTaskNotification），不双投
 * 由代码序保证。
 */

/** 重投幂等键前缀；完整键 = 前缀 + 稳定 taskId（workflow runId）。 */
const REFEED_KEY_PREFIX = "refeed_";

function refeedCommandId(taskId: string): string {
  return `${REFEED_KEY_PREFIX}${taskId}`;
}

/**
 * 主体可恢复性：run 的**真实终态**（completed/errored/stopped——snapshot.runStatus 只在终态
 * 在场，这里仍按字面收口，running/pending/lost 一律不认）且非 superseded。superseded 的工作
 * 已归后继 run，重投是错的；非终态的新生命周期自带通知。
 * （TERMINAL_RUN_STATUSES + isResumableSettlement 的 core 内联同形谓词——bootstrap 不可被 core 反向依赖。）
 */
function isRecoverableRunSnapshot(snapshot: DynamicWorkflowRunSnapshot): boolean {
  const runStatus = snapshot.runStatus;
  if (runStatus !== "completed" && runStatus !== "errored" && runStatus !== "stopped") {
    return false;
  }
  if (runStatus === "stopped" && snapshot.stopReason === "superseded") return false;
  return true;
}

interface TerminalWorkflowWake {
  originMeta: BackgroundResultOriginMeta;
  taskId: string;
  text: string;
}

/**
 * 只认当前格式的终态 workflow 窄结果 wake：taskId 派生幂等键的原料、backgroundSource
 * 判主体类别（bash/subagent 是重启即死的主体）、workflowNotification.kind 判窄结果种类
 * （escalation/hole/stall/blocked 可重导出且 qid/时钟已陈旧，不重投）。
 */
function readTerminalWorkflowWake(
  payload: SessionInputRecord["payload"],
): TerminalWorkflowWake | undefined {
  const taskId = payload.taskId;
  if (typeof taskId !== "string" || taskId.length === 0) return undefined;
  const text = payload.text;
  if (typeof text !== "string" || text.length === 0) return undefined;
  const originMeta = payload.originMeta;
  if (typeof originMeta !== "object" || originMeta === null || Array.isArray(originMeta)) {
    return undefined;
  }
  const meta = originMeta as Record<string, unknown>;
  if (meta.backgroundSource !== "workflow") return undefined;
  const manifest = meta.workflowNotification;
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return undefined;
  }
  if ((manifest as Record<string, unknown>).kind !== "terminal") return undefined;
  return { originMeta: originMeta as BackgroundResultOriginMeta, taskId, text };
}

/**
 * 扫描 discarded 的 terminal workflow wake，对可恢复主体幂等重投。返回重投条数。
 *
 * 由 resumeFromStore 在 sweep 之后、SessionResumed/hooks 之后调用（见 resume.ts）；自身
 * 吞掉扫描/查询错误（warn、返回 0），不阻断 resume 主链——与 sweep 的既有容错一致。
 */
export async function refeedRecoverableBackgroundWakes(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  const store = this.sessionStore;
  if (!store?.listSessionInputs) return 0;
  try {
    // 一次全量：候选（discarded wake）与 claim 集合（幂等键行任意状态）同源于此快照。
    const records = await store.listSessionInputs({ sessionID: this.sessionId });
    const existingIds = new Set(records.map((record) => record.id));
    const claimedTaskIds = new Set<string>();
    let refeedCount = 0;
    for (const record of records) {
      if (record.kind !== "backgroundNotification") continue;
      if (record.status !== "discarded" || record.statusReason !== "session_resumed") continue;
      const wake = readTerminalWorkflowWake(record.payload);
      if (!wake) continue;
      const { originMeta, taskId, text } = wake;
      if (claimedTaskIds.has(taskId)) continue;
      const commandId = refeedCommandId(taskId);
      if (existingIds.has(commandId)) continue;
      const port = this.dynamicWorkflowRunPort;
      if (!port?.getTask) {
        this.logger?.debug?.("Background wake re-feed skipped: workflow run port unavailable", {
          ...traceContextToLogContext(traceContext),
          event: "runtime.background_wake_refeed.skipped",
          module: "core.runtime",
          reason: "run_port_unavailable",
          taskId,
        });
        continue;
      }
      let snapshot: DynamicWorkflowRunSnapshot | undefined;
      try {
        snapshot = await port.getTask(taskId);
      } catch (error) {
        // 主体判别失败保持丢弃：审计优先于投递，下一次 resume 可重试。
        this.logger?.warn("Background wake re-feed skipped: workflow run lookup failed", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "runtime.background_wake_refeed.lookup_failed",
          module: "core.runtime",
          status: "failed",
          taskId,
        });
        continue;
      }
      if (!snapshot || !isRecoverableRunSnapshot(snapshot)) {
        this.logger?.debug?.("Background wake re-feed skipped: subject not recoverable", {
          ...traceContextToLogContext(traceContext),
          event: "runtime.background_wake_refeed.skipped",
          module: "core.runtime",
          reason: snapshot ? "run_not_recoverable" : "run_missing",
          runStatus: snapshot?.runStatus,
          stopReason: snapshot?.stopReason,
          taskId,
        });
        continue;
      }
      // 同实例二次 resume 且原 wake 命令仍在内存队列未消费时，sweep 已把原行收口、再以
      // refeed_<taskId> 入队会在同批合并出重复文本。按 taskId + text 精确匹配队列已有
      // task-notification 则不再入队（只按 taskId 会误匹配同 run 的 stall/progress 提醒，
      // 把终态窄结果误 claim 后丢投）；但投递责任已由在队命令承担，故补写 claim 行吸收
      // 后续 resume 的重投（否则原命令消费后 promote 因行已 discarded 而空转，下次再投一次）。
      const alreadyQueued = this.runtimeCommandQueue.snapshot().some(
        (command) =>
          command.mode === "task-notification" &&
          command.taskId === taskId &&
          command.text === text,
      );
      if (alreadyQueued) {
        const claimedOnBehalf = await persistBackgroundTaskNotificationClaim.call(this, {
          commandId,
          originMeta,
          taskId,
          text,
          traceContext,
        });
        if (claimedOnBehalf) {
          claimedTaskIds.add(taskId);
          existingIds.add(commandId);
        }
        this.logger?.info?.("Background wake re-feed skipped: notification already queued", {
          ...traceContextToLogContext(traceContext),
          commandId,
          event: "runtime.background_wake_refeed.already_queued",
          module: "core.runtime",
          runStatus: snapshot.runStatus,
          stopReason: snapshot.stopReason,
          taskId,
        });
        continue;
      }
      // claim-first（bugfix：键行写入曾是 fire-and-forget）：键行是 at-most-once 的认领凭证，
      // 必须先落库确认成功再入队——若先入队后写账本，写失败时通知已投递而键行缺位，下一次
      // resume 会把同一条 wake 再投一次。写失败则不入队、不认领，留待下次 resume 重试。
      const claimed = await persistBackgroundTaskNotificationClaim.call(this, {
        commandId,
        originMeta,
        taskId,
        text,
        traceContext,
      });
      if (!claimed) continue;
      enqueueBackgroundTaskNotification.call(this, {
        claimPersisted: true,
        commandId,
        originMeta,
        taskId,
        text,
        traceContext,
      });
      claimedTaskIds.add(taskId);
      existingIds.add(commandId);
      refeedCount += 1;
      this.logger?.info?.("Background wake re-fed after resume", {
        ...traceContextToLogContext(traceContext),
        commandId,
        event: "runtime.background_wake_refeed.enqueued",
        module: "core.runtime",
        runStatus: snapshot.runStatus,
        stopReason: snapshot.stopReason,
        taskId,
      });
    }
    return refeedCount;
  } catch (error) {
    this.logger?.warn("Failed to re-feed recoverable background wakes", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "runtime.background_wake_refeed.scan_failed",
      module: "core.runtime",
      status: "failed",
    });
    return 0;
  }
}
