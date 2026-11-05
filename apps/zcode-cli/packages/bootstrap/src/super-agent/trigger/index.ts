export { createTriggerSubsystem } from "./impl.js";
export type { TriggerSubsystemDeps } from "./impl.js";
export { createTriggerSubscriptions } from "./subscriptions.js";
export { createControlPlaneLease } from "./control-plane-lease.js";
export {
  CONTROL_PLANE_HEARTBEAT_INTERVAL_MS,
  CONTROL_PLANE_LEASE_TTL_MS,
} from "./control-plane-lease.js";
export { routeOwned, triggerDeliveryCommandId } from "./event-router.js";
export { dispatchHumanExplicit } from "./human-explicit-dispatch.js";
export { applyVerdicts } from "./verdict-interpret.js";
export {
  assembleHumanExplicitWakeText,
  extractPayloadText,
  GOAL_SUMMARY_MAX_CHARS,
  NARROW_RESULT_MAX_CHARS,
  NARROW_RESULT_MAX_COUNT,
  OPEN_QUESTION_MAX_CHARS,
  OPEN_QUESTION_MAX_COUNT,
  RECALL_SEED_MAX_COUNT,
  TRIGGER_DISPATCH_TEXT_MAX_CHARS,
} from "./payload-text.js";
export type {
  CreateTaskInput,
  DispatchHumanExplicitOutcome,
  FindWorkerByThreadKeyInput,
  LeaderClaimInput,
  LeaderClaimResult,
  RevokeTriggerSubscriptionSelector,
  ResumableWorker,
  ResumeWorkerInput,
  RouteOwnedOutcome,
  SuperAgentTriggerContract,
  TriggerDecisionLogEntryInput,
  TriggerDeliveryInput,
  TriggerDeliveryReceipt,
  TriggerMandatePort,
  TriggerMandateTier,
  TriggerSchemeCard,
  TriggerSpecRunInput,
  TriggerSpecRunPort,
  TriggerSubscriptionLane,
  TriggerSubscriptionOwnerKind,
  TriggerSubscriptionRecord,
  TriggerSubscriptionStatus,
  TriggerVerdictDecision,
  TriggerWorkerContext,
  UpsertTriggerSubscriptionInput,
} from "./contract.js";
export { TRIGGER_SUBSCRIPTION_LEASE_TTL_MS } from "./contract.js";
// 组合根注入端口（delivery / worker / decisionLog）在 ports.ts（与
// dispatchBridgePort.ts 同惯例：端口独立于契约面文件）。
export type {
  TriggerDecisionLogPort,
  TriggerHostDeliveryPort,
  TriggerWorkerPort,
} from "./ports.js";
// 派发桥（M7② dispatch_requests 状态机 + push/ACK 协议端）由 ws7 实现于
// dispatchBridge.ts，端口类型在 dispatchBridgePort.ts；按 spec §2.1 桥五方法
// （claimDue / pushDispatch / onHostAck / sweepSkipped / resumePendingAfterBoot）
// 属本模块公共面，这里 re-export 端口类型 + 实现工厂（组合根经声明入口
// index.ts 拿到桥实例，不深 import 实现文件）。
export * from "./dispatchBridgePort.js";
export {
  createDispatchBridge,
  dispatchCommandIdForRun,
} from "./dispatchBridge.js";
export type { DispatchBridgeDeps } from "./dispatchBridge.js";
export {
  createDispatchLoop,
  DISPATCH_GRACE_MS,
  DISPATCH_LOOP_INTERVAL_MS,
} from "./dispatchLoop.js";
export type { DispatchLoop, DispatchLoopOptions } from "./dispatchLoop.js";
