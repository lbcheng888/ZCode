import type { DatabaseSync } from "node:sqlite";
import { schemeCardSchema } from "@zcode/shared/zcode-protocol-v4";

import type {
  TriggerChengGateVerdict,
  TriggerMandatePort,
  TriggerSchemeCard,
  TriggerSpecRunInput,
  TriggerSpecRunPort,
  TriggerVerdictDecision,
} from "./contract.js";
import type { TriggerDecisionLogPort } from "./ports.js";
import {
  getTriggerEvent,
  setTriggerEventAdjudicationStatus,
  type TriggerEventRow,
} from "./trigger-events-access.js";
import {
  chengJobIdOfTriggerEvent,
  evaluateTriggerOutboundChengGate,
} from "./outbound-gate.js";

export interface VerdictInterpretDeps {
  db: DatabaseSync;
  decisionLog: TriggerDecisionLogPort;
  now?: () => number;
  /**
   * M4 三档解析端口；缺席 = 恒隐式 record_only（P2 / flag 关字节兼容）。
   * 事务内只读调用（resolveFor 同步）。
   */
  mandate?: TriggerMandatePort;
  /**
   * M5 spec run 启动端口。档位解析为 speculative/auto 时，事务 commit 后
   * 异步调用（两阶段：同步事务不 await 执行）。
   */
  specRun?: TriggerSpecRunPort;
  /**
   * trigger payload 带 `chengJobId` 时的真实 gate 解析端口（组合根接 host verify）。
   * 缺失 = 装配错误；解析失败原样上抛，不启动 run。
   */
  resolveSpecRunGate?: (jobId: string) => Promise<TriggerChengGateVerdict>;
  /**
   * M6 五字段方案门（= features.mandateGate，缺省 false 字节兼容）：
   * accept 缺 scheme 直接降级 record_only，不产卡、不执行。
   */
  proposalGate?: boolean;
  /** 第二阶段异步 dispatch 的失败告警缝；缺席时未处理拒绝原样暴露（let it crash）。 */
  onError?: (error: unknown, context: string) => void;
}

/** 域键已知前缀（与 adjudication driver / 组合根 deriveTriggerClass 同式，spec §8-14⑤）。 */
const DOMAIN_KEY_PREFIXES = ["bot:", "schedule:", "webhook:"] as const;

/**
 * thread_key → 域键（`<workspaceIdentity>|<域键>`）。与裁决驱动器的
 * domainKeyOf 逐行同式——单侧改动会让 applyVerdicts 查档与批转写的 mandate 键错位，
 * Phase 3 的 auto 行查不到（fail-closed 方向但批转静默失效，spec §8-14⑤）。
 */
function domainKeyOf(threadKey: string): string {
  let scanFrom = threadKey.length;
  while (scanFrom > 0) {
    const at = threadKey.lastIndexOf("|", scanFrom - 1);
    if (at < 0) break;
    const suffix = threadKey.slice(at + 1);
    if (DOMAIN_KEY_PREFIXES.some((prefix) => suffix.startsWith(prefix))) {
      return suffix;
    }
    scanFrom = at;
  }
  const first = threadKey.indexOf("|");
  return first >= 0 ? threadKey.slice(first + 1) : threadKey;
}

/** trigger_class 推导（§1.4 形态 `bot:<botId>` / `cron:<automationId>` / `webhook:<routeId>`）。 */
function triggerClassOf(event: TriggerEventRow): string {
  const domain = domainKeyOf(event.threadKey);
  if (domain.startsWith("bot:")) {
    return `bot:${domain.slice(4).split("+")[0] ?? ""}`;
  }
  if (domain.startsWith("schedule:")) {
    return `cron:${domain.slice("schedule:".length)}`;
  }
  if (domain.startsWith("webhook:")) {
    return domain;
  }
  return `${event.source}:${domain}`;
}

/**
 * M6 方案卡校验。返回合法规格或不全的原因；合法才允许出卡/执行。
 * 缺字段必须响亮（reason 带字段路径），不允许一句话摘要混过。
 */
function validateSchemeCard(
  decision: TriggerVerdictDecision,
): { ok: true; card: TriggerSchemeCard } | { ok: false; detail: string } {
  if (!decision.scheme) return { ok: false, detail: "missing" };
  const parsed = schemeCardSchema.safeParse(decision.scheme);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
    return { ok: false, detail: [...new Set(fields)].join(",") };
  }
  return { ok: true, card: parsed.data };
}

/**
 * applyVerdicts（§2.1 / M3 解释执行 / M4 档位分派 / M6 方案门）。
 *
 * 阶段一（事务前异步 ChengGate 预检 → 同步 BEGIN IMMEDIATE 事务）：
 * - reject → adjudication_status=rejected + decision_log(reject)。
 * - record-only 决议 → adjudication_status=record_only + decision_log(record_only)，不执行。
 * - accept → mandate.resolveFor 三档：
 *   - 未注入 mandate（flag 关）/ record_only → would-accept 卡片（decision_log
 *     disposition=would_accept），不建订阅、不触发执行。
 *   - speculative/auto → adjudication_status=accepted + decision_log(accept)，
 *     待 commit 后异步 dispatch。
 * - proposalGate 开时 accept 必须带五字段方案卡：缺失/不完整降级 record_only 并留
 *   `scheme_card_incomplete:<字段>` 计数行（一句话摘要不构成「最佳方案」）。
 * 档位要求执行但未注入 specRun = 装配错误：事务内抛错 → 整体 ROLLBACK、零写入。
 *
 * 阶段二（commit 后）：异步逐个调用 specRun.start；失败经 onError 告警（不吞）。
 *
 * fail-closed：任一 decision.triggerId 未命中 trigger_events 行、或写入循环中任一条
 * decisionLog.record 抛错，整体 ROLLBACK 后上浮，零部分执行（否则同批重放会因
 * decision_log append-only 产生重复行）；verdict JSON/schema 解析失败的整批
 * record-only 降级由裁决驱动器在调用本方法前完成（T2 归 adjudication）。
 */
export async function applyVerdicts(
  deps: VerdictInterpretDeps,
  batchId: string,
  decisions: readonly TriggerVerdictDecision[],
): Promise<void> {
  const dispatches: TriggerSpecRunInput[] = [];

  // 出站门预检（事务前）：卡/回复在落库前就要知道 Cheng gate。同一 job 只求一次；
  // 带 chengJobId 但未注入 resolver 是装配错误，事务前抛错 => 零写入。
  const events = decisions.map((decision) => {
    const event = getTriggerEvent(deps.db, decision.triggerId);
    if (!event) {
      throw new Error(
        `applyVerdicts: triggerId 未命中 trigger_events 行，整批拒绝执行 (${decision.triggerId})`,
      );
    }
    return event;
  });
  const gatePromises = new Map<
    string,
    ReturnType<typeof evaluateTriggerOutboundChengGate>
  >();
  const blockedByTrigger = new Map<string, string>();
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index]!;
    if (decision.disposition === "reject") continue;
    const event = events[index]!;
    const jobId = chengJobIdOfTriggerEvent(event);
    if (jobId === undefined) continue;
    let gatePromise = gatePromises.get(jobId);
    if (gatePromise === undefined) {
      gatePromise = evaluateTriggerOutboundChengGate(event, {
        resolveGate: deps.resolveSpecRunGate,
      });
      gatePromises.set(jobId, gatePromise);
    }
    const gate = await gatePromise;
    if (!gate.allowed) blockedByTrigger.set(decision.triggerId, gate.reason);
  }

  // 事务前提：decisionLog 端口与 deps.db 是同一库句柄（组合根注入同一
  // openSuperAgentDatabase 句柄），否则 decision_log 写不在本事务覆盖内。
  deps.db.exec("begin immediate");
  try {
    const now = deps.now?.() ?? Date.now();
    decisions.forEach((decision, index) => {
      const event = events[index]!;
      const evidence = decision.evidence ?? [];
      const planRef =
        decision.chengPlanId === undefined ? {} : { chengPlanId: decision.chengPlanId };
      const blockedReason = blockedByTrigger.get(decision.triggerId);
      if (blockedReason !== undefined) {
        setTriggerEventAdjudicationStatus(
          deps.db,
          decision.triggerId,
          "record_only",
          now,
          decision.chengPlanId,
        );
        deps.decisionLog.record({
          workspaceIdentity: event.workspaceIdentity,
          triggerId: decision.triggerId,
          origin: "adjudication",
          disposition: "record_only",
          batchId,
          reason: blockedReason,
          evidence,
          ...planRef,
          createdAt: now,
        });
        return;
      }
      if (decision.disposition === "reject") {
        setTriggerEventAdjudicationStatus(
          deps.db,
          decision.triggerId,
          "rejected",
          now,
          decision.chengPlanId,
        );
        deps.decisionLog.record({
          workspaceIdentity: event.workspaceIdentity,
          triggerId: decision.triggerId,
          origin: "adjudication",
          disposition: "reject",
          batchId,
          reason: decision.reason ?? null,
          evidence,
          ...planRef,
          createdAt: now,
        });
        return;
      }

      // 显式 record-only：纯审计，不执行。flag 关保持 P2 收敛（would_accept 行）；
      // flag 开（proposalGate）按语义落 record_only——不产卡、不打扰用户。
      if (decision.disposition === "record-only") {
        setTriggerEventAdjudicationStatus(
          deps.db,
          decision.triggerId,
          "record_only",
          now,
          decision.chengPlanId,
        );
        deps.decisionLog.record({
          workspaceIdentity: event.workspaceIdentity,
          triggerId: decision.triggerId,
          origin: "adjudication",
          disposition: deps.proposalGate === true ? "record_only" : "would_accept",
          batchId,
          reason: decision.reason ?? null,
          evidence,
          ...planRef,
          createdAt: now,
        });
        return;
      }

      // accept：M6 方案门先于档位分派——没有完整方案就没有可交付/可执行的内容。
      const scheme = validateSchemeCard(decision);
      if (deps.proposalGate === true && !scheme.ok) {
        setTriggerEventAdjudicationStatus(
          deps.db,
          decision.triggerId,
          "record_only",
          now,
          decision.chengPlanId,
        );
        deps.decisionLog.record({
          workspaceIdentity: event.workspaceIdentity,
          triggerId: decision.triggerId,
          origin: "adjudication",
          disposition: "record_only",
          batchId,
          reason: `scheme_card_incomplete:${scheme.detail}`,
          evidence,
          ...planRef,
          createdAt: now,
        });
        return;
      }

      const mandateTier = deps.mandate
        ? deps.mandate.resolveFor(triggerClassOf(event), {
            workspaceIdentity: event.workspaceIdentity,
            now,
          }).tier
        : "record_only";

      if (mandateTier === "record_only") {
        setTriggerEventAdjudicationStatus(
          deps.db,
          decision.triggerId,
          "record_only",
          now,
          decision.chengPlanId,
        );
        deps.decisionLog.record({
          workspaceIdentity: event.workspaceIdentity,
          triggerId: decision.triggerId,
          origin: "adjudication",
          disposition: "would_accept",
          batchId,
          reason: decision.reason ?? null,
          evidence,
          ...planRef,
          ...(scheme.ok ? { card: scheme.card } : {}),
          createdAt: now,
        });
        return;
      }

      if (!deps.specRun) {
        throw new Error(
          `applyVerdicts: mandate 档位要求执行但未注入 specRun 端口 (triggerId=${decision.triggerId}, tier=${mandateTier})`,
        );
      }
      setTriggerEventAdjudicationStatus(
        deps.db,
        decision.triggerId,
        "accepted",
        now,
        decision.chengPlanId,
      );
      deps.decisionLog.record({
        workspaceIdentity: event.workspaceIdentity,
        triggerId: decision.triggerId,
        origin: "adjudication",
        disposition: "accept",
        batchId,
        reason: decision.reason ?? null,
        evidence,
        ...planRef,
        ...(scheme.ok ? { card: scheme.card } : {}),
        createdAt: now,
      });
      const chengJobId = chengJobIdOfTriggerEvent(event);
      dispatches.push({
        triggerId: decision.triggerId,
        workspaceIdentity: event.workspaceIdentity,
        threadKey: event.threadKey,
        source: event.source,
        tier: mandateTier,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        evidence,
        ...(scheme.ok ? { card: scheme.card } : {}),
        ...(chengJobId === undefined ? {} : { chengJobId }),
      });
    });
    deps.db.exec("commit");
  } catch (error) {
    try {
      deps.db.exec("rollback");
    } catch {
      // 回滚失败不覆盖原始写入/校验错误（与 control-plane-lease 同约定）。
    }
    throw error;
  }

  // 阶段二：commit 之后才启动执行，事务内零 await；失败不静默（A10 告警缝）。
  for (const input of dispatches) {
    void Promise.resolve()
      .then(async () => {
        let gate: TriggerChengGateVerdict | undefined;
        if (input.chengJobId !== undefined) {
          if (!deps.resolveSpecRunGate) {
            throw new Error(
              `applyVerdicts: trigger payload 带 chengJobId 但未注入 resolveSpecRunGate (triggerId=${input.triggerId})`,
            );
          }
          gate = await deps.resolveSpecRunGate(input.chengJobId);
        }
        if (gate !== undefined && !gate.ok) {
          // 红 gate = 静默丢弃：不启动 spec run、不产生出站；只留 decision_log 计数与状态收敛。
          const now = deps.now?.() ?? Date.now();
          deps.decisionLog.record({
            workspaceIdentity: input.workspaceIdentity,
            triggerId: input.triggerId,
            origin: "adjudication",
            disposition: "record_only",
            batchId,
            reason: `cheng_gate_blocked:${gate.reasons.join(",") || gate.level}`,
            evidence: input.evidence ?? [],
            createdAt: now,
          });
          setTriggerEventAdjudicationStatus(deps.db, input.triggerId, "record_only", now);
          return;
        }
        await deps.specRun!.start({
          ...input,
          ...(gate === undefined ? {} : { chengGate: gate }),
        });
      })
      .catch((error: unknown) => {
        if (deps.onError) {
          deps.onError(error, `super_agent.trigger.spec_run ${input.triggerId}`);
          return;
        }
        // 无告警缝 = 装配错误：未处理拒绝原样暴露，不吞。
        throw error;
      });
  }
}
