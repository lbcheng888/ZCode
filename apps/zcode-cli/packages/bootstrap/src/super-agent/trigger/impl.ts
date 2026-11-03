import type { DatabaseSync } from "node:sqlite";

import { createControlPlaneLease } from "./control-plane-lease.js";
import type {
  DispatchHumanExplicitOutcome,
  LeaderClaimInput,
  LeaderClaimResult,
  RevokeTriggerSubscriptionSelector,
  RouteOwnedOutcome,
  SuperAgentTriggerContract,
  TriggerMandatePort,
  TriggerSpecRunPort,
  TriggerSubscriptionRecord,
  TriggerVerdictDecision,
  UpsertTriggerSubscriptionInput,
} from "./contract.js";
import type {
  TriggerDecisionLogPort,
  TriggerHostDeliveryPort,
  TriggerWorkerPort,
} from "./ports.js";
import { routeOwned } from "./event-router.js";
import { dispatchHumanExplicit } from "./human-explicit-dispatch.js";
import { applyVerdicts } from "./verdict-interpret.js";
import { createTriggerSubscriptions } from "./subscriptions.js";

export interface TriggerSubsystemDeps {
  /** daemon 域库句柄（super-agent-storage openSuperAgentDatabase 返回值）。 */
  db: DatabaseSync;
  /** host RPC CommandInbox 投递面（组合根注入；kill-switch 关时由宿主注入 no-op 直通）。 */
  delivery: TriggerHostDeliveryPort;
  /** worker 装配面（组合根注入，桥接既有 createTask / resume 路径）。 */
  worker: TriggerWorkerPort;
  /** decision_log 写入口（结构 = super-agent-decision-log 的 record 面）。 */
  decisionLog: TriggerDecisionLogPort;
  now?: () => number;
  /** M4 mandate 三档端口；additive-optional，缺席 = 恒隐式 record_only（flag 关）。 */
  mandate?: TriggerMandatePort;
  /** M5 spec run 启动端口；additive-optional，档位要求执行时缺席 = 事务前响亮抛错。 */
  specRun?: TriggerSpecRunPort;
  /** M6 五字段方案门；缺省 false（P2 字节兼容）。 */
  proposalGate?: boolean;
  /** 异步 spec run dispatch 失败告警缝（组合根注入）。 */
  onError?: (error: unknown, context: string) => void;
}

/**
 * super-agent-trigger 组合工厂：一个域库句柄 + 三个注入端口得到完整契约面。
 * 组合根（create-app / daemon 控制面宿主，§7-7 里程碑 A）负责打开域库并注入端口；
 * 本工厂不做任何 I/O 之外的副作用，不启动循环（leader 循环由宿主持有 lease 后自驱）。
 */
export function createTriggerSubsystem(deps: TriggerSubsystemDeps): SuperAgentTriggerContract {
  const subscriptions = createTriggerSubscriptions(deps.db);
  const controlPlaneLease = createControlPlaneLease(deps.db);
  const routerDeps = {
    db: deps.db,
    subscriptions,
    delivery: deps.delivery,
    now: deps.now,
  };
  const dispatchDeps = {
    db: deps.db,
    subscriptions,
    worker: deps.worker,
    delivery: deps.delivery,
    now: deps.now,
  };
  const verdictDeps = {
    db: deps.db,
    decisionLog: deps.decisionLog,
    now: deps.now,
    mandate: deps.mandate,
    specRun: deps.specRun,
    proposalGate: deps.proposalGate,
    onError: deps.onError,
  };

  return {
    upsertSubscription(input: UpsertTriggerSubscriptionInput): TriggerSubscriptionRecord {
      return subscriptions.upsert(input);
    },
    revokeSubscription(selector: RevokeTriggerSubscriptionSelector): number {
      return subscriptions.revoke(selector);
    },
    sweepExpiredLeases(now: number): number {
      return subscriptions.sweepExpiredLeases(now);
    },
    renewActiveLeases(now: number, workspaceIdentity?: string): number {
      return subscriptions.renewActiveLeases(now, workspaceIdentity);
    },
    routeOwned(triggerId: string): Promise<RouteOwnedOutcome> {
      return routeOwned(routerDeps, triggerId);
    },
    dispatchHumanExplicit(triggerId: string): Promise<DispatchHumanExplicitOutcome> {
      return dispatchHumanExplicit(dispatchDeps, triggerId);
    },
    applyVerdicts(batchId: string, decisions: readonly TriggerVerdictDecision[]): void {
      applyVerdicts(verdictDeps, batchId, decisions);
    },
    tryClaimLeadership(input: LeaderClaimInput): LeaderClaimResult {
      return controlPlaneLease.tryClaim(input);
    },
    heartbeatLeadership(input: LeaderClaimInput): boolean {
      return controlPlaneLease.heartbeat(input);
    },
  };
}
