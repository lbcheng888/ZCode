/**
 * super-agent 控制面组合根（spec super-agent-trigger-subsystem-spec §7-7 裁决 ①
 * 里程碑 A / 设计 M1-M3、§5 flags、§3.3 leader 租约）。
 *
 * 职责：把 super-agent 各模块的 contract 工厂按 spec §2.2 依赖方向装配成一条可运行
 * 链——域库 → 三个仓储 + intake + trigger（订阅/EventRouter/分派器/leader 租约）+
 * 裁决驱动器 + 派发桥（宿主注入 tasks-index 时）——并提供：
 * - `triggerSink`：TriggerSink 形状的摄取适配器（ingest + 三边路由动作），供入站宿主
 *   注入 botsService（注入点随入站宿主，见 spec §5.2 / out-of-partition 记录）；
 * - 生命周期 start/stop：leader 租约竞争、心跳续期、启动清过期、存量回填、驱动器启停；
 *   非 leader = 纯转发（sink 恒 handled=false，spec §3.3）；
 * - `listPendingWouldAccept`：would-accept 卡片读面（§5.5 数据源 = decision_log 行 +
 *   trigger_events 摘要），供 v4 快照 pendingWouldAccept 投影。
 *
 * 组合根注入只有两个跨层边界（spec §2.2：super-agent 模块禁 import packages/services /
 * 宿主实现）：`handleCommand`（= 协议宿主 CommandInbox 在线投递面，gateway.handleCommand）
 * 与 `autoReplyGuard`（= botsService admitAutoReplyTurn 包装）。二者缺席时 flag-on 启动
 * 期响亮失败——kill-switch 只认 features.eventRouter=false，不做静默 legacy 降级。
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "@zcode/contracts";
import type {
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
} from "@zcode/core";
import type {
  CommandAck,
  CommandEnvelope,
  PendingWouldAcceptCard,
} from "@zcode/shared/zcode-protocol-v4";
import {
  schemeCardSchema,
  wouldAcceptSourceSchema,
} from "@zcode/shared/zcode-protocol-v4";

import { getSuperAgentDatabasePath } from "./paths.js";
import {
  openSuperAgentDatabase,
  type SuperAgentDatabaseHandle,
} from "../super-agent/storage/index.js";
import {
  createDecisionLog,
  type SuperAgentDecisionLogContract,
} from "../super-agent/decision-log/index.js";
import { createWriteLeases } from "../super-agent/write-leases/index.js";
import type { SuperAgentWriteLeasesContract } from "../super-agent/write-leases/index.js";
import {
  createMandateContract,
  createMandateRepo,
  type SuperAgentMandateContract,
  type SuperAgentMandateRepo,
} from "../super-agent/mandate/index.js";
import { getTriggerEvent } from "../super-agent/trigger/trigger-events-access.js";
import type { SuperAgentAdmissionMandateResolution } from "./super-agent-admission-facts.js";
import {
  createSuperAgentIntake,
  runSubscriptionBackfill,
  type AutoReplyGuardPort,
  type IngestRoute,
  type SubscriptionBackfillSeed,
  type TriggerEnvelope,
  type SuperAgentIntakeContract,
} from "../super-agent/intake/index.js";
import {
  CONTROL_PLANE_HEARTBEAT_INTERVAL_MS,
  createDispatchBridge,
  createTriggerSubsystem,
  createTriggerSubscriptions,
  extractPayloadText,
  triggerDeliveryCommandId,
  TRIGGER_DISPATCH_TEXT_MAX_CHARS,
  type DispatchPushCommand,
  type DispatchPushOutcome,
  type DispatchPushPort,
  type RouteOwnedOutcome,
  type SuperAgentDispatchBridgeContract,
  type SuperAgentTriggerContract,
  type TriggerHostDeliveryPort,
  type TriggerSpecRunPort,
  type TriggerWorkerPort,
} from "../super-agent/trigger/index.js";
import {
  createAdjudicationDriver,
  type AdjudicationDeliveryPort, type AdjudicationModelSessionRequest,
  type AdjudicationModelSessionPort, type SuperAgentAdjudicationContract,
} from "../super-agent/adjudication/index.js";

/** CommandInbox 在线投递面（= 协议宿主 ConversationV4Gateway.handleCommand 的形状）。 */
export type SuperAgentCommandHandle = (rawParams: unknown) => Promise<CommandAck>;

/**
 * 本组合根承载的会话事实（单会话宿主 = create-app 的 sessionId）。
 * 多会话宿主（协议服务器）改注完整 TriggerWorkerPort 覆盖默认单会话实现。
 */
export interface SuperAgentSessionFace {
  sessionId: string;
  /** 会话是否空闲（无活动回合）——默认 worker 的 terminal 判据。 */
  isIdle(): boolean;
}

/** 宿主注入面（spec §2.2 组合根注入；features.eventRouter=true 时 delivery/guard 必填）。 */
export interface SuperAgentHostPorts {
  /**
   * CommandInbox 在线投递（milestone A 进程内真实适配器的唯一入口）：
   * 协议宿主传 gateway.handleCommand；派发桥 push、EventRouter 直通、human-explicit
   * resume/createTask 全部经它走唯一 admission（M1 禁旁路）。
   */
  handleCommand: SuperAgentCommandHandle;
  /** bots 互答守卫（admitAutoReplyTurn 包装，spec §3.1 Fast Path 第四项）。 */
  autoReplyGuard: AutoReplyGuardPort;
  /** 多会话宿主注入完整 worker 装配面；缺省 = 本会话单 worker 实现。 */
  worker?: TriggerWorkerPort;
  /** tasks-index 库路径（宿主经 services getTasksIndexDatabasePath 解析后传入）；注入才建派发桥。 */
  tasksIndexDatabasePath?: string;
  /**
   * would-accept 权威投影变化通知（裁决产出卡片 / 批转成功）。宿主据此刷新 v4 快照
   * 投影（delta 生产者），已订阅的 desktop/web 收件箱无需重订阅即可收敛。缺席 = 宿主
   * 无该表面（纯 CLI），不影响控制面行为。
   */
  onWouldAcceptChanged?: () => void;
  /** §5.1 存量订阅回填种子（宿主枚举既有 bot conversation）；缺省空表零新增。 */
  backfillSeeds?: readonly SubscriptionBackfillSeed[];
  /** 宿主调用过 setDataBaseDir() 时注入（spec §1.1 实施偏差），否则缺省 getSuperAgentDatabasePath()。 */
  superAgentDatabasePath?: string;
}

/**
 * TriggerSink 形状的摄取结果（与 packages/services TriggerSinkOutcome 结构对齐；
 * 本包不 import services，结构类型即合同）。
 */
export type SuperAgentTriggerSinkOutcome =
  | {
      handled: true;
      triggerId: string;
      route: IngestRoute;
      delivery?: "routed" | "delivery_failed"; // §3.4 additive：owned/human-explicit 投递结果。
    }
  | { handled: false };

export interface SuperAgentTriggerSink {
  ingest(envelope: TriggerEnvelope): Promise<SuperAgentTriggerSinkOutcome>;
}

export interface CreateSuperAgentControlPlaneOptions {
  /** leader 租约与回填/续期的作用域键（workspaceIdentity?.trim() || workspacePath）。 */
  workspaceIdentity: string;
  /** 控制面进程/会话实例 id（缺省随机 uuid）。 */
  ownerId?: string;
  onError: (error: unknown, context: string) => void;
  /**
   * 单会话宿主事实。headless daemon（多会话宿主）注入完整 `hostPorts.worker` 时无需
   * sessionFace；二者至少提供一个，否则装配期响亮失败。
   */
  sessionFace?: SuperAgentSessionFace;
  hostPorts: SuperAgentHostPorts;
  /** 裁决短命 model-only 会话（create-app 用 runtime 辅助生成面构建，测试可注脚本端口）。 */
  adjudicationSession: AdjudicationModelSessionPort;
  /** 注入时钟（测试/回放）；缺省 Date.now。 */
  now?: () => number;
  /**
   * M4 执行档开关（= features.mandateGate，缺省 false）：true 时 mandate 注入域库仓储
   * 启用三档解析，并同时在 applyVerdicts 启用 M6 五字段方案门。
   */
  mandateGate?: boolean;
  /**
   * M5 spec run 启动端口（组合根装配 spec-lane dispatcher 后注入）。mandateGate 开且
   * 档位解析为 speculative/auto 时必需；缺席 = applyVerdicts 事务前响亮抛错。
   */
  specRun?: TriggerSpecRunPort;
}

export interface SuperAgentControlPlaneContracts {
  intake: SuperAgentIntakeContract;
  trigger: SuperAgentTriggerContract;
  adjudication: SuperAgentAdjudicationContract;
  decisionLog: SuperAgentDecisionLogContract;
  writeLeases: SuperAgentWriteLeasesContract;
  mandate: SuperAgentMandateContract;
  mandateRepo: SuperAgentMandateRepo;
  /** 宿主注入 tasks-index 时在场；缺省缺席（scheduler 未写 pending 行期间同 spec ws7 偏差）。 */
  dispatchBridge?: SuperAgentDispatchBridgeContract;
}

export interface SuperAgentControlPlane {
  /** 入站宿主注入 botsService 的摄取适配器（flag-on 且 leader 才接管，否则纯转发）。 */
  readonly triggerSink: SuperAgentTriggerSink;
  readonly contracts: SuperAgentControlPlaneContracts;
  /** 组合根持有的域库句柄：读面给宿主诊断/测试；写者仍是各模块仓储（storage CONTRACT）。 */
  readonly database: SuperAgentDatabaseHandle;
  isLeader(): boolean;
  /** would-accept 卡片（§5.5）：decision_log(would_accept) × trigger_events 摘要联读；已批转卡被读面过滤。 */
  listPendingWouldAccept(): PendingWouldAcceptCard[];
  /**
   * would-accept 一键批转 auto（spec §2.1 `promoteWouldAccept(cardId)` / design M4）：
   * 写显式 mandate(tier=auto) 行 + decision_log(would_accept_convert) 行，读面随即过滤该卡。
   * P2 执行档未启用（resolveFor 恒隐式 record_only）——行先落、auto 生效归 Phase 3，
   * 卡片与命令文案如实呈现该边界。幂等：同卡重复调用零新增行（convert 行按 trigger_id
   * 去重；mandate 行按 (workspace, triggerClass) partial unique，已有 auto 行复用其 id）。
   * 卡不存在 / 非本 workspace / 非待批卡：响亮抛错。
   */
  promoteWouldAccept(cardId: string): Promise<void>;
  /**
   * M4 mandateFacts 生产者：按 triggerId 读 trigger_events 行 → 推导 trigger_class →
   * `mandate.resolveFor` 真契约 → 本回合 admission 需要的 typed 结论。
   *
   * - `features.mandateGate=false`（缺省）：恒返回 undefined = 不绑定事件来源，M4 门不激活，
   *   flag 关字节兼容（spec §0）。
   * - flag 开：按 fast_path 分类。`human_explicit` 是人类显式直通，design M2 明定
   *   「免 Mandate、免攒批」⇒ 返回 exempt（按 user-origin 执行）；owned / unowned_candidate
   *   走 resolveFor 真契约，未命中显式行时返回隐式 record_only（expiresAt=null）。
   * - trigger 行缺失 / 跨 workspace / Fast Path 未收敛：原样抛错（fail-closed）。
   */
  resolveAdmissionMandateFacts(
    triggerId: string,
  ): SuperAgentAdmissionMandateResolution | undefined;
  /** leader 竞争 + 清过期 + 回填 + 驱动器启动 + 桥续推；幂等。 */
  start(): Promise<void>;
  /**
   * 优雅释放本人 leader 租约（milestone-b-spec §2.5，`delete ... where owner_id=?`）。
   * 必须在 stop() 关库前调用；返回释放行数（follower/已释放为 0）。
   */
  releaseLeadership(): number;
  /** 对称停止：心跳/驱动器/短窗会话 + 关库；幂等。在途裁决批不取消（自然收尾，spec §8-12）。 */
  stop(): void;
}

const SUPER_AGENT_CLIENT_ID = "super-agent-trigger";
const DISPATCH_CLIENT_ID = "super-agent-dispatch";

/** trigger_events.fast_path 三态之一（spec §1.2）；human-explicit 免 Mandate（design M2:118）。 */
const HUMAN_EXPLICIT_FAST_PATH = "human_explicit";

/** would-accept 卡片摘要上限：与投递文本同预算（常量单点，payload-text 同源）。 */
const WOULD_ACCEPT_SUMMARY_MAX_CHARS = TRIGGER_DISPATCH_TEXT_MAX_CHARS;

function buildSendTextEnvelope(input: {
  commandId: string;
  sessionId: string;
  text: string;
  requestedDelivery?: "startNow" | "queue" | "guide";
  clientId: string;
  triggerId?: string;
  taint?: boolean;
  now: number;
}): CommandEnvelope {
  return {
    commandId: input.commandId,
    clientId: input.clientId,
    sessionId: input.sessionId,
    type: "sendText",
    payload: {
      text: input.text,
      ...(input.requestedDelivery ? { requestedDelivery: input.requestedDelivery } : {}),
    },
    issuedAt: input.now,
    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
    ...(input.taint !== undefined ? { taint: input.taint } : {}),
  };
}

function receiptFromAck(ack: CommandAck): DispatchPushOutcome {
  if (ack.status === "accepted") return { status: "admitted" };
  if (ack.status === "duplicate") return { status: "duplicate" };
  return {
    status: "rejected",
    ...(ack.reasonCode !== undefined ? { reasonCode: ack.reasonCode } : {}),
  };
}

/**
 * EventRouter / human-explicit 分派器的投递面（spec §2.1 TriggerHostDeliveryPort）：
 * TriggerDeliveryInput → sendText 信封 → CommandInbox 唯一 admission，回执映射
 * admitted|duplicate|rejected。lane 映射按 M1 车道表（wire 面只有 startNow/queue/guide）：
 * followup→queue（idle 起轮 / busy 入队待 autoDrain）、guide→guide（步边界行内）、
 * inject→拒绝（wire schema 无 inject 面，P2 生产订阅只产 followup；见 spec 实施偏差）。
 */
export function createCommandInboxTriggerDelivery(options: {
  handleCommand: SuperAgentCommandHandle;
  now?: () => number;
}): TriggerHostDeliveryPort {
  const now = options.now ?? Date.now;
  return {
    async deliver(input) {
      if (input.lane === "inject") {
        // 响亮拒绝而非静默改车道：inject≠queue 是 M1 语义（不唤醒），错投会唤醒。
        return {
          status: "rejected",
          reasonCode: "proto.deliveryLaneUnsupported",
        };
      }
      const requestedDelivery: "queue" | "guide" = input.lane === "guide" ? "guide" : "queue";
      const ack = await options.handleCommand(
        buildSendTextEnvelope({
          commandId: input.commandId,
          sessionId: input.sessionId,
          text: input.text,
          requestedDelivery,
          clientId: SUPER_AGENT_CLIENT_ID,
          triggerId: input.triggerId,
          taint: input.taint,
          now: now(),
        }),
      );
      return receiptFromAck(ack);
    },
  };
}

/**
 * 派发桥 push 端（spec §1.6 / M7②，dispatchBridgePort 注释：milestone A 的 push =
 * host 进程内 CommandInbox 直推生产适配器）。admission 回执即 ACK：admitted/duplicate
 * 转发 onHostAck settle dispatched；rejected 不 ACK（行保持 pushed，按崩溃重投续推）。
 */
export function createCommandInboxDispatchPush(options: {
  handleCommand: SuperAgentCommandHandle;
  /** 结构 = SuperAgentDispatchBridgeContract.onHostAck；组合根接同一桥实例。 */
  onHostAck?: (commandId: string, outcome: "admitted" | "duplicate") => void;
  now?: () => number;
}): DispatchPushPort {
  const now = options.now ?? Date.now;
  return {
    async push(command: DispatchPushCommand): Promise<DispatchPushOutcome> {
      if (command.sessionId === null) {
        // 无目标会话无法构成 sendText admission；响亮拒绝，不向空会话刷推送。
        return { status: "rejected", reasonCode: "dispatch.sessionRequired" };
      }
      if (command.payload === null || command.payload.length === 0) {
        return { status: "rejected", reasonCode: "dispatch.payloadMissing" };
      }
      const ack = await options.handleCommand(
        buildSendTextEnvelope({
          commandId: command.commandId,
          sessionId: command.sessionId,
          text: command.payload,
          clientId: DISPATCH_CLIENT_ID,
          now: now(),
        }),
      );
      const receipt = receiptFromAck(ack);
      if (receipt.status === "admitted" || receipt.status === "duplicate") {
        options.onHostAck?.(command.commandId, receipt.status);
      }
      return receipt;
    },
  };
}

/**
 * 单会话宿主的默认 worker 装配面（spec §2.1 TriggerWorkerPort；M2 分派器只做决策，
 * 会话面经此注入）。查订阅定 worker，resume/createTask 一律经 CommandInbox 投递——
 * 触发输入不旁路唯一 admission（M1）。
 *
 * - 订阅命中本会话 → terminal = face.isIdle()；stoppedByHuman 恒 false：本组合根没有
 *   「人为停止」事实面（cancel 史在 runtime 控制面未暴露），且单会话下 resume 与
 *   createTask 同为「向本会话提交唤醒输入」，语义差仅在多会话宿主（其注入完整 worker）。
 * - 订阅只命中外部会话 → terminal 恒 false（跨组合根不可观测终态）：走 M1 busy 行内
 *   投递，由目标会话 admission 裁决，不冒充 resume、不建平行会话。
 * - 不供 `context`（M2 上下文装配缺口，spec §8-5 登记）：同会话唤醒时目标摘要与历史
 *   已在会话内，再拼一份属冗余投喂；装配随宿主注入完整 worker 批启用，本缺省面不拼装。
 */
export function createInProcessTriggerWorkerPort(options: {
  database: DatabaseSync;
  face: SuperAgentSessionFace;
  handleCommand: SuperAgentCommandHandle;
  now?: () => number;
}): TriggerWorkerPort {
  const now = options.now ?? Date.now;
  const subscriptions = createTriggerSubscriptions(options.database);

  const submitWake = async (sessionId: string, triggerId: string, text: string): Promise<void> => {
    const ack = await options.handleCommand(
      buildSendTextEnvelope({
        // 幂等键 = triggerId+sessionId（§1.3 fan-out）：同一触发对一会话至多一条输入。
        commandId: triggerDeliveryCommandId(triggerId, sessionId),
        sessionId,
        text,
        requestedDelivery: "queue",
        clientId: SUPER_AGENT_CLIENT_ID,
        triggerId,
        // 触发事件恒 taint=1（§1.2；intake 对非 true 直接抛错），唤醒文本源自 trigger payload。
        taint: true,
        now: now(),
      }),
    );
    if (ack.status !== "accepted" && ack.status !== "duplicate") {
      throw new Error(
        `super-agent worker 唤醒投递被拒: ${ack.reasonCode ?? ack.status}（triggerId=${triggerId}）`,
      );
    }
  };

  return {
    findWorkerByThreadKey(input): ReturnType<TriggerWorkerPort["findWorkerByThreadKey"]> {
      const active = subscriptions.listActive(input.workspaceIdentity, input.threadKey, now());
      const own = active.find((row) => row.sessionId === options.face.sessionId);
      const bound = own ?? active[0];
      if (!bound) return undefined;
      if (bound.sessionId !== options.face.sessionId) {
        return { sessionId: bound.sessionId, terminal: false, stoppedByHuman: false };
      }
      return {
        sessionId: bound.sessionId,
        terminal: options.face.isIdle(),
        stoppedByHuman: false,
      };
    },
    async resume(input) {
      if (input.sessionId !== options.face.sessionId) {
        // 只可能发生在宿主注入的 worker 与默认实现混用时：响亮失败，不静默改投。
        throw new Error(
          `super-agent worker.resume 越出本组合根会话: ${input.sessionId}（需宿主注入完整 worker port）`,
        );
      }
      await submitWake(input.sessionId, input.triggerId, input.text);
      return { sessionId: input.sessionId };
    },
    async createTask(input) {
      await submitWake(options.face.sessionId, input.triggerId, input.text);
      return { sessionId: options.face.sessionId };
    },
  };
}

interface WouldAcceptRow {
  card_id: string;
  created_at: number;
  source: string;
  payload: string;
  reason: string | null;
  card_payload: string | null;
}

/**
 * M6 方案卡读面校验：card_payload 是 decision-log 写入时的 JSON；解析/结构不符
 * 一律视为缺内容（不静默 cast 进协议投影）。
 */
function parseWouldAcceptScheme(raw: string | null): PendingWouldAcceptCard["scheme"] {
  if (raw === null) return undefined;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = schemeCardSchema.safeParse(parsedJson);
  return parsed.success ? parsed.data : undefined;
}

/** mandate 批转写行的 policyVersion（M4 不可变授权记录首版；契约示例同值）。 */
const MANDATE_PROMOTE_POLICY_VERSION = 1;

/** thread_key 域键已知前缀（spec §1.2 P2 档；与 adjudication/driver.ts 同集）。 */
const TRIGGER_CLASS_DOMAIN_PREFIXES = ["bot:", "schedule:", "webhook:"] as const;

/**
 * thread_key → 域键（`<workspaceIdentity>|<域键>`）。workspaceIdentity 可含 `|`，
 * 按前缀从右往左找分界——与 adjudication/driver.ts `domainKeyOf` 同式，
 * 两处改动必须同步（mandate 唯一索引与裁决查档共用此键）。
 */
function domainKeyOfThreadKey(threadKey: string): string {
  let scanFrom = threadKey.length;
  while (scanFrom > 0) {
    const at = threadKey.lastIndexOf("|", scanFrom - 1);
    if (at < 0) break;
    const suffix = threadKey.slice(at + 1);
    if (TRIGGER_CLASS_DOMAIN_PREFIXES.some((prefix) => suffix.startsWith(prefix))) {
      return suffix;
    }
    scanFrom = at;
  }
  const first = threadKey.indexOf("|");
  return first >= 0 ? threadKey.slice(first + 1) : threadKey;
}

/**
 * trigger_class 推导（spec §1.4 形态 `bot:<botId>` / `cron:<automationId>` /
 * `webhook:<routeId>`）：批转写 mandate 行的键，与裁决驱动器 `triggerClassOf` 同式
 * ——键错档会让 Phase 3 查档静默落隐式 record_only，两处必须同步。
 */
function deriveTriggerClass(threadKey: string, source: string): string {
  const domain = domainKeyOfThreadKey(threadKey);
  if (domain.startsWith("bot:")) {
    return `bot:${domain.slice(4).split("+")[0] ?? ""}`;
  }
  if (domain.startsWith("schedule:")) {
    return `cron:${domain.slice("schedule:".length)}`;
  }
  if (domain.startsWith("webhook:")) {
    return domain;
  }
  return `${source}:${domain}`;
}

/**
 * create-app 的裁决会话缺省实现（design M3 zcode 落点：model-only 回合 + 零工具面）：
 * 经 runtime 辅助文本生成直调，tools 恒空 = 比 toolAllowlist 更严的 fail-closed 主闸
 * （T1 零副作用锚点：裁决会话物理无工具可调）。destroySession 为幂等空操作——
 * 无状态直调没有短窗会话可毁（短窗 KV 复用未接，见 spec 实施偏差）。
 */
export function createRuntimeAdjudicationSession(deps: {
  generateWorkspaceText: (
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<WorkspaceGenerateTextResult>;
  resolveSelection: () => ModelSelection | undefined;
  abortSignal: AbortSignal;
  /** 按本批候选数推导输出预算（已按模型 spec 钳制）；缺席 = 沿用既有语义（headless daemon 必须提供）。 */
  resolveMaxOutputTokens?: (request: AdjudicationModelSessionRequest) => number | undefined;
}): AdjudicationModelSessionPort {
  return {
    async run(request) {
      if (deps.abortSignal.aborted) {
        throw new Error("裁决会话已中止（控制面 stop）");
      }
      const selection = deps.resolveSelection();
      if (!selection) {
        // 裁决必须有可执行模型；未绑定 = 装配/配置错误，响亮失败不降级。
        throw new Error("裁决会话缺模型选择（会话 Selection 与默认 Selection 均未绑定）");
      }
      const result = await deps.generateWorkspaceText(
        {
          selection,
          prompt: request.prompt,
          tools: [],
          querySource: "super_agent_adjudication",
          maxOutputTokens: deps.resolveMaxOutputTokens?.(request),
        },
        { abortSignal: deps.abortSignal },
      );
      return {
        outputText: result.text,
        ...(result.usage?.inputTokens !== undefined && result.usage?.outputTokens !== undefined
          ? {
              usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
              },
            }
          : {}),
      };
    },
    destroySession() {
      // 无状态直调：窗内重复 run 各自独立生成，无会话可销毁（幂等）。
    },
  };
}

/**
 * 装配控制面（只构造、不启动循环——start/stop 归宿主生命周期，spec §3.3）。
 * 打开域库失败/迁移失败原样上浮；端口缺站在 flag-on 下于 create-app 启动期响亮失败。
 */
export async function createSuperAgentControlPlane(
  options: CreateSuperAgentControlPlaneOptions,
): Promise<SuperAgentControlPlane> {
  const now = options.now ?? Date.now;
  const { hostPorts } = options;
  const ownerId = options.ownerId ?? randomUUID();
  const workspaceIdentity = options.workspaceIdentity;
  const databasePath = hostPorts.superAgentDatabasePath ?? getSuperAgentDatabasePath();
  const db = await openSuperAgentDatabase({ databasePath });

  let leader = false;
  let started = false;
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let tasksIndexDb: DatabaseSync | undefined;
  let bridge: SuperAgentDispatchBridgeContract | undefined;

  const decisionLog = createDecisionLog(db);
  const writeLeases = createWriteLeases(db);
  const mandateRepo = createMandateRepo(db);
  // M4：flag 关（缺省）不注入 repo = 恒隐式 record_only（P2 字节兼容）；
  // flag 开才启用「显式行 UNION 隐式缺省」三档解析。
  const mandateGate = options.mandateGate === true;
  const mandate = mandateGate
    ? createMandateContract({ repo: mandateRepo, workspaceIdentity, now })
    : createMandateContract();
  const delivery = createCommandInboxTriggerDelivery({
    handleCommand: hostPorts.handleCommand,
    now,
  });
  // M4 guide 车道 fail-closed：事件回合的 mandateFacts 在 admission 边界绑定到本输入的
  // queryId/turnId，而 guide 行内投递进入的是 active turn——工具判定只读 active turn
  // 自己的回合事实，绑定永远不命中，事件写操作会按 active turn 的 user-origin 执行，
  // 绕过 mandate 门。mandateGate 开时只允许 human-explicit（免 Mandate）走 guide；
  // 其余事件拒绝该车道，由派发方按 followup/新回合重投（响亮失败，不静默改车道）。
  const mandateGuardedDelivery: TriggerHostDeliveryPort = mandateGate
    ? {
        async deliver(input) {
          if (input.lane === "guide") {
            const event = getTriggerEvent(db, input.triggerId);
            if (!event) {
              throw new Error(
                `mandateGate guide 投递缺少 trigger 行: triggerId=${input.triggerId}（装配错误，fail-closed）`,
              );
            }
            if (event.fastPath !== HUMAN_EXPLICIT_FAST_PATH) {
              return {
                status: "rejected",
                reasonCode: "proto.eventGuideLaneRequiresUserOrigin",
              };
            }
          }
          return delivery.deliver(input);
        },
      }
    : delivery;
  const intake = createSuperAgentIntake({
    db,
    decisionLog,
    autoReplyGuard: hostPorts.autoReplyGuard,
    now,
  });
  const sessionFace = options.sessionFace;
  if (!hostPorts.worker && !sessionFace) {
    // 多会话宿主必须注入完整 worker port；单会话宿主必须给 sessionFace。两者都缺 =
    // 无法构成 resume/createTask，装配期响亮失败（不静默建平行会话）。
    throw new Error(
      "super-agent 组合根缺少 worker 装配面：hostPorts.worker 与 sessionFace 至少提供一个",
    );
  }
  const worker =
    hostPorts.worker ??
    createInProcessTriggerWorkerPort({
      database: db,
      face: sessionFace as SuperAgentSessionFace,
      handleCommand: hostPorts.handleCommand,
      now,
    });
  const trigger = createTriggerSubsystem({
    db,
    delivery: mandateGuardedDelivery,
    worker,
    decisionLog,
    now,
    ...(mandateGate ? { mandate } : {}),
    ...(options.specRun ? { specRun: options.specRun } : {}),
    proposalGate: mandateGate,
    onError: options.onError,
  });
  // would-accept 权威投影变化通知：卡片产出/批转后由宿主刷新已订阅客户端的投影。
  // 宿主回调失败不能反向破坏已提交的裁决/批转事实（事务已 commit）；只走 onError 告警。
  const notifyWouldAcceptChanged = (): void => {
    if (!hostPorts.onWouldAcceptChanged) return;
    try {
      hostPorts.onWouldAcceptChanged();
    } catch (error) {
      options.onError(error, "super_agent.would_accept.notify");
    }
  };
  // 裁决交付 = trigger.applyVerdicts 精确接缝；同步落库成功后通知投影刷新。reject-only
  // 批也通知，但投影无变化时发布端不发 delta（幂等，不制造空帧）。
  const adjudicationDelivery: AdjudicationDeliveryPort = {
    applyVerdicts(batchId, decisions) {
      trigger.applyVerdicts(batchId, decisions);
      notifyWouldAcceptChanged();
    },
  };
  const adjudication = createAdjudicationDriver({
    db,
    session: options.adjudicationSession,
    delivery: adjudicationDelivery,
    mandate,
    onError: options.onError,
  });

  if (hostPorts.tasksIndexDatabasePath !== undefined) {
    try {
      // 宿主声明 tasks-index 已迁移（§1.6 表由 services 迁移建出）；未迁移时响亮失败，
      // 不静默不建桥。node:sqlite 开库会先落文件再 prepare——缺文件直接开会在抛
      // no such table 之前留下 0 字节空库污染「未迁移」现场（已实测），故先探测存在性：
      // 缺文件不建库不落文件，原样抛错（services 迁移 CREATE TABLE IF NOT EXISTS 可接管）。
      if (!existsSync(hostPorts.tasksIndexDatabasePath)) {
        throw new Error(
          `tasks-index 未迁移（数据库文件不存在）: ${hostPorts.tasksIndexDatabasePath}（宿主注入即声明已迁移，spec §8-6）`,
        );
      }
      tasksIndexDb = new DatabaseSync(hostPorts.tasksIndexDatabasePath);
      // push 收到 admission 回执即回填 onHostAck settle（M7② ACK 即 settled；同库 CAS
      // 幂等，网关侧 onAdmissionReceipt 若日后也接桥，重复 ACK 收敛 noop）。
      const push = createCommandInboxDispatchPush({
        handleCommand: hostPorts.handleCommand,
        onHostAck: (commandId, outcome) => {
          try {
            bridge?.onHostAck(commandId, outcome);
          } catch (error) {
            options.onError(error, "super_agent.dispatch.host_ack");
          }
        },
        now,
      });
      bridge = createDispatchBridge({ db: tasksIndexDb, push, now });
    } catch (error) {
      // 装配中途失败：对称关闭已打开句柄不泄漏；原始错误原样上浮（不吞不包装）。
      try {
        tasksIndexDb?.close();
      } catch {
        // 关闭失败不掩盖原始装配错误。
      }
      tasksIndexDb = undefined;
      try {
        db.close();
      } catch {
        // 关闭失败不掩盖原始装配错误。
      }
      throw error;
    }
  }

  const claim = () => trigger.tryClaimLeadership({ workspaceIdentity, ownerId, now: now() });

  /** leader 接管动作（首次竞争成功与 follower→leader 接管共用，spec §3.3/§5.1）。 */
  const enterLeader = (): void => {
    leader = true;
    trigger.sweepExpiredLeases(now());
    writeLeases.sweepExpired(now());
    adjudication.start();
    try {
      runSubscriptionBackfill({
        db,
        seeds: hostPorts.backfillSeeds ?? [],
        now: now(),
      });
    } catch (error) {
      // 回填失败不阻断控制面（幂等任务，下一次接管重跑）；按 A10 告警缝暴露。
      options.onError(error, "super_agent.subscription_backfill");
    }
    if (bridge) {
      void bridge.resumePendingAfterBoot().catch((error: unknown) => {
        options.onError(error, "super_agent.dispatch.resumePendingAfterBoot");
      });
    }
  };

  const tickLeadership = (): void => {
    try {
      if (leader) {
        const held = trigger.heartbeatLeadership({ workspaceIdentity, ownerId, now: now() });
        if (!held) {
          // 连续失联：主动降级 follower 并停控制面循环（spec §3.3）。
          leader = false;
          adjudication.stop();
          options.onError(
            new Error(`super-agent leader 租约丢失: ${workspaceIdentity}`),
            "super_agent.leadership.lost",
          );
          return;
        }
        trigger.renewActiveLeases(now(), workspaceIdentity);
        return;
      }
      const result = claim();
      if (result.kind === "leader") enterLeader();
    } catch (error) {
      options.onError(error, "super_agent.leadership.heartbeat");
    }
  };

  const triggerSink: SuperAgentTriggerSink = {
    async ingest(envelope) {
      // 未启动 / 非 leader / 已停止：纯转发（spec §3.3 follower 与 kill-switch 同语义，
      // 调用方走 legacy 直路）。
      if (!started || closed || !leader) return { handled: false };
      const result = await intake.ingest(envelope);
      switch (result.route) {
        case "owned": {
          const outcome: RouteOwnedOutcome = await trigger.routeOwned(result.triggerId);
          if (outcome.kind !== "routed") {
            // orphaned/delivery_failed/not_found 都不是可静默消费的事实（A10 告警缝）；
            // delivery_failed 行保持未决，供启动重放扫描覆盖（§4 流五 3）。
            options.onError(
              new Error(`owned 直通未收敛: ${outcome.kind}（triggerId=${result.triggerId}）`),
              "super_agent.route_owned",
            );
          }
          const delivery = outcome.kind === "routed" ? "routed" : "delivery_failed";
          return { handled: true, triggerId: result.triggerId, route: result.route, delivery };
        }
        case "human_explicit": {
          const outcome = await trigger.dispatchHumanExplicit(result.triggerId);
          if (outcome.kind === "delivery_failed" || outcome.kind === "not_found") {
            options.onError(
              new Error(
                `human-explicit 直通未收敛: ${outcome.kind}（triggerId=${result.triggerId}）`,
              ),
              "super_agent.dispatch_human_explicit",
            );
          }
          const delivered =
            outcome.kind === "resumed" ||
            outcome.kind === "created_task" ||
            outcome.kind === "delivered";
          return {
            handled: true,
            triggerId: result.triggerId,
            route: result.route,
            delivery: delivered ? "routed" : "delivery_failed",
          };
        }
        case "unowned_candidate":
          adjudication.notifyCandidate(result.triggerId);
          break;
        case "rejected":
          break;
      }
      return { handled: true, triggerId: result.triggerId, route: result.route };
    },
  };

  const listPendingWouldAccept = (): PendingWouldAcceptCard[] => {
    const rows = db
      .prepare(
        `select d.id as card_id, d.created_at as created_at, d.reason as reason,
                d.card_payload as card_payload,
                e.source as source, e.payload as payload
           from decision_log d
           join trigger_events e on e.id = d.trigger_id
          where d.disposition = 'would_accept' and d.workspace_identity = ?
            and not exists (
              select 1 from decision_log c
               where c.origin = 'would_accept_convert'
                 and c.workspace_identity = d.workspace_identity
                 and c.trigger_id = d.trigger_id
            )
          order by d.created_at desc, d.id`,
      )
      .all(workspaceIdentity) as unknown as WouldAcceptRow[];
    const cards: PendingWouldAcceptCard[] = [];
    for (const row of rows) {
      const parsed = wouldAcceptSourceSchema.safeParse(row.source);
      if (!parsed.success) {
        // trigger_events.source 是 P2 闭集；越集行 = 装配/迁移错误，告警并跳过该行，
        // 不把非法值 cast 进协议投影。
        options.onError(
          new Error(`would-accept 卡片源越集: ${String(row.source)}（cardId=${row.card_id}）`),
          "super_agent.would_accept.source",
        );
        continue;
      }
      const scheme = parseWouldAcceptScheme(row.card_payload);
      if (mandateGate && !scheme) {
        // M6 出口门：缺五字段方案内容不外发（一句话摘要不构成「最佳方案」）。
        // 行保留在 decision_log 供审计/计数（reason = scheme_card_incomplete:* 或旧行）。
        options.onError(
          new Error(
            `would-accept 卡缺五字段方案内容，出口拦截（cardId=${row.card_id}，reason=${row.reason ?? "null"}）`,
          ),
          "super_agent.would_accept.scheme_gate",
        );
        continue;
      }
      const text = extractPayloadText(row.payload, WOULD_ACCEPT_SUMMARY_MAX_CHARS);
      cards.push({
        cardId: row.card_id,
        source: parsed.data,
        // P2 无 Mandate 行为：建议档位 = 隐式 record_only（spec §0 硬不变量 / M4 缺省）。
        suggestedTier: "record_only",
        summary: text.length > 0 ? text : (row.reason ?? ""),
        createdAt: row.created_at,
        ...(scheme ? { scheme } : {}),
      });
    }
    return cards;
  };

  /**
   * 批转实现（契约面注释见 SuperAgentControlPlane.promoteWouldAccept）。整段包
   * BEGIN IMMEDIATE…COMMIT：mandate 行与 convert 行同事务原子提交（与 applyVerdicts
   * 同约定——decisionLog / mandate 仓储与本 db 是同一句柄）；任一步失败 ROLLBACK 后
   * 原样上浮，不留「有 mandate 无 convert」的半状态（那会让卡永远停在收件箱）。
   * 锁内重读保证并发重复批转收敛为幂等：后到者看到 convert 行直接提交返回。
   */
  const promoteWouldAccept = async (cardId: string): Promise<void> => {
    db.exec("begin immediate");
    try {
      const card = db
        .prepare(`select workspace_identity, trigger_id, disposition from decision_log where id = ?`)
        .get(cardId) as
        | { workspace_identity: string; trigger_id: string | null; disposition: string }
        | undefined;
      if (
        !card ||
        card.workspace_identity !== workspaceIdentity ||
        card.disposition !== "would_accept" ||
        !card.trigger_id
      ) {
        throw new Error(`would-accept 卡不可批转: ${cardId}（不存在 / 非本 workspace / 非待批卡）`);
      }
      const triggerId = card.trigger_id;
      const trigger = db
        .prepare(`select source, thread_key from trigger_events where id = ?`)
        .get(triggerId) as { source: string; thread_key: string } | undefined;
      if (!trigger) {
        // 读面按 trigger_id 关联卡片：trigger 行缺失 = 装配/迁移损坏，响亮失败不静默跳过。
        throw new Error(`would-accept 卡的 trigger 行缺失: triggerId=${triggerId}`);
      }
      const converted =
        db
          .prepare(
            `select 1 from decision_log
              where origin = 'would_accept_convert' and workspace_identity = ? and trigger_id = ?
              limit 1`,
          )
          .get(workspaceIdentity, triggerId) !== undefined;
      if (converted) {
        // 同卡（同 trigger）已批转：幂等收敛，零新增行。
        db.exec("commit");
        return;
      }
      const triggerClass = deriveTriggerClass(trigger.thread_key, trigger.source);
      const active = mandateRepo.getActive(workspaceIdentity, triggerClass, now());
      if (active && active.tier !== "auto") {
        // P2 只写 auto 行；出现非 auto 显式行 = 升级/降级语义未实现，响亮失败不静默覆盖。
        throw new Error(
          `mandate 已有非 auto 显式行，无法批转: triggerClass=${triggerClass} tier=${active.tier}`,
        );
      }
      // 同 triggerClass 已有 auto 行（他卡先批）：复用其 id，不撞 partial unique。
      const mandateId =
        active?.id ??
        mandateRepo.insert({
          workspaceIdentity,
          triggerClass,
          tier: "auto",
          policyVersion: MANDATE_PROMOTE_POLICY_VERSION,
          now: now(),
        }).id;
      decisionLog.record({
        workspaceIdentity,
        triggerId,
        origin: "would_accept_convert",
        disposition: "accept",
        reason: `promote auto mandate ${mandateId}`,
        evidence: [`card:${cardId}`, `mandate:${mandateId}`],
        createdAt: now(),
      });
      db.exec("commit");
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
        // 回滚失败不覆盖原始错误（与 applyVerdicts 同约定）。
      }
      throw error;
    }
    // 事务已提交：卡片从权威读面消失，通知宿主刷新已订阅投影（幂等重复批转折返早退
    // 路径不通知，因为没有状态变化）。
    notifyWouldAcceptChanged();
  };

  /**
   * M4 解析契约（spec §1.4 / §8-15②）：flag 关恒 undefined；flag 开按 trigger 行推导
   * trigger_class 后调 `resolveFor`。tier/mandateId/expiresAt 全部来自 resolveFor 的同一次
   * getActive 读快照——不得为补过期时间再查一次（两次读之间可能被 revoke/换行）。
   */
  const resolveAdmissionMandateFacts = (
    triggerId: string,
  ): SuperAgentAdmissionMandateResolution | undefined => {
    if (!mandateGate) return undefined;
    const trigger = getTriggerEvent(db, triggerId);
    if (!trigger) {
      throw new Error(
        `事件回合 mandate 解析缺少 trigger 行: triggerId=${triggerId}（intake 未落行 = 装配错误，fail-closed）`,
      );
    }
    if (trigger.workspaceIdentity !== workspaceIdentity) {
      throw new Error(
        `事件回合 mandate 解析跨 workspace: triggerId=${triggerId}（${trigger.workspaceIdentity} ≠ ${workspaceIdentity}，fail-closed）`,
      );
    }
    // design M2：human-explicit 是人类显式直通，免 Mandate；按既有 user-origin 执行，
    // 否则人类直接对话会被未配置的隐式 record_only 判成只读。
    if (trigger.fastPath === HUMAN_EXPLICIT_FAST_PATH) {
      return { kind: "human_explicit_exempt" };
    }
    if (trigger.fastPath === null) {
      throw new Error(
        `事件回合 mandate 解析遇到未路由 trigger 行: triggerId=${triggerId}（Fast Path 未收敛，fail-closed）`,
      );
    }
    const triggerClass = deriveTriggerClass(trigger.threadKey, trigger.source);
    const verdict = mandate.resolveFor(triggerClass);
    return {
      kind: "mandate",
      facts: {
        triggerId,
        tier: verdict.tier,
        ...(verdict.mandateId ? { mandateId: verdict.mandateId } : {}),
        expiresAt: verdict.source === "explicit" ? (verdict.expiresAt ?? null) : null,
      },
    };
  };

  return {
    triggerSink,
    database: db,
    contracts: {
      intake,
      trigger,
      adjudication,
      decisionLog,
      writeLeases,
      mandate,
      mandateRepo,
      ...(bridge ? { dispatchBridge: bridge } : {}),
    },
    isLeader: () => leader,
    listPendingWouldAccept,
    promoteWouldAccept,
    resolveAdmissionMandateFacts,
    releaseLeadership(): number {
      if (closed) return 0;
      // 优雅收口（§2.5）：只删本人 ownerId 的租约行；失败原样上浮给 entry 的 onError。
      const result = db.prepare("delete from control_plane_leases where workspace_identity = ? and owner_id = ?").run(workspaceIdentity, ownerId);
      return Number(result.changes); // 不改 leader：stop() 仍据此停驱动器、清心跳。
    },
    async start() {
      if (started || closed) return;
      started = true;
      const result = claim();
      if (result.kind === "leader") enterLeader();
      heartbeatTimer = setInterval(tickLeadership, CONTROL_PLANE_HEARTBEAT_INTERVAL_MS);
      // 不阻塞宿主进程退出（CLI 会话结束即退；控制面随进程生命周期，spec §2.2）。
      heartbeatTimer.unref?.();
    },
    stop() {
      if (closed) return;
      closed = true;
      started = false;
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (leader) {
        adjudication.stop();
        leader = false;
      }
      try {
        db.close();
      } finally {
        tasksIndexDb?.close();
      }
    },
  };
}
