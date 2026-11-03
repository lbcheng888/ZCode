/**
 * super-agent-trigger 组合根注入端口（行为面）：host RPC 投递、worker 装配、
 * decision_log 写入。与 dispatchBridgePort.ts 同惯例——端口定义独立于 contract.ts，
 * 载荷数据类型仍在 contract.ts（本文件单向 import，避免环）；contract.ts 面
 * （SuperAgentTriggerContract 九方法）与 spec §2.1 一致，三个注入端口不计入
 * 契约方法上限（architecture max-public-methods）。
 *
 * 结构契约 = 兄弟模块的公开面子集：TriggerDecisionLogPort.record 对齐
 * super-agent-decision-log 的 record；不 import 兄弟模块文件。
 */
import type {
  CreateTaskInput,
  FindWorkerByThreadKeyInput,
  ResumableWorker,
  ResumeWorkerInput,
  TriggerDecisionLogEntryInput,
  TriggerDeliveryInput,
  TriggerDeliveryReceipt,
} from "./contract.js";

/** 组合根注入的投递实现：把信封（含 triggerId/taint）经 host RPC 投在线 attachment。 */
export interface TriggerHostDeliveryPort {
  deliver(input: TriggerDeliveryInput): Promise<TriggerDeliveryReceipt>;
}

/**
 * worker 装配面（M2）：host 组合根注入，桥接既有 bots 私聊 createTask / 会话 resume
 * 路径。分派器只做决策与订阅落库，不自己创建会话——新线程首条直接消息延迟与现状
 * 持平的验收依赖 createTask 直通既有路径。
 */
export interface TriggerWorkerPort {
  findWorkerByThreadKey(input: FindWorkerByThreadKeyInput): ResumableWorker | undefined;
  resume(input: ResumeWorkerInput): Promise<{ sessionId: string }>;
  createTask(input: CreateTaskInput): Promise<{ sessionId: string }>;
}

/** 结构类型 = super-agent-decision-log 的 record 子集；不 import 兄弟模块文件。 */
export interface TriggerDecisionLogPort {
  record(entry: TriggerDecisionLogEntryInput): void;
}
