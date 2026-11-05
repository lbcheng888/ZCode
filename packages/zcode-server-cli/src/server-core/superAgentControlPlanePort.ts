/**
 * Core 侧 control-plane RPC 端口装配（milestone-b-spec §3.2 / §3.4 / §3.6 / §4.2）。
 *
 * 本文件把生产 RPC 客户端（`createControlPlaneClient`）收窄成 services 的
 * `SuperAgentControlPlaneRpcPort`，并承担 §3.6 的代际判据：
 * - Supervisor 经 Core IPC 推送 state/firstReadyAt/crashSignalObserved；
 * - Core 绝不能自行从「某一条消息失败」推断 legacy 窗口；
 * - 唯一允许 `handled:false` 的两种运行态 = 本代际启动窗口（starting 且尚无任何
 *   ready/exit/close/spawn error）或 follower plane；其余状态原样抛可重试错误。
 *
 * `workspace.ensure` 在每次进入新 child 代际后按 workspace 幂等执行一次（leader 缓存），
 * follower 不缓存以便后续接管；ensure 失败/空 workspace 一律响亮失败，不返回 handled:false。
 *
 * child → Core 回调：本批次只实现 `backfill.seeds`。Core 尚无 bot conversation → session
 * 种子枚举（B-SPEC §3.3/§8-8 待实现），因此诚实返回空表（不回填任何行）；不能伪造订阅，
 * 也不能让 ensure 因该方法未实现而永久失败。
 */
import {
  CONTROL_PLANE_RPC_ERROR_CODES,
  backfillSeedsParamsSchema,
  backfillSeedsResultSchema,
  type ControlPlaneTriggerEnvelope,
  type ControlPlaneTriggerIngestResult,
  type ScheduleAuditParams,
  type WorkspaceEnsureResult,
} from "@zcode/shared/super-agent-control-plane-protocol";
import type { SuperAgentControlPlaneRpcPort } from "@zcode/services/node";
import {
  controlPlaneCoreStateMessageSchema,
  type ControlPlaneState,
} from "../contracts.js";
import {
  ControlPlaneRpcError,
  type ControlPlaneClient,
} from "../supervisor/controlPlaneClient.js";

export interface SuperAgentControlPlaneGateSnapshot {
  state: ControlPlaneState;
  generation: number;
  firstReadyAt: number | null;
  crashSignalObserved: boolean;
  crashBudgetExhausted: boolean;
}

/**
 * 默认值必须是 fail-closed：Core 在收到第一条 Supervisor 状态推送前不能假设 legacy
 * 窗口打开，否则 Core 重启窗口内的事件可能既被旧 child 处理又被 legacy 双跑。
 */
const INITIAL_SNAPSHOT: SuperAgentControlPlaneGateSnapshot = {
  state: "stopped",
  generation: 0,
  firstReadyAt: null,
  crashSignalObserved: false,
  crashBudgetExhausted: false,
};

export class SuperAgentControlPlaneGenerationGate {
  private snapshot: SuperAgentControlPlaneGateSnapshot = INITIAL_SNAPSHOT;
  /** 无法解析的状态消息 = 代际事实不可信；保持 fail-closed，不回 legacy。 */
  private invalid = false;

  public update(raw: unknown): boolean {
    const parsed = controlPlaneCoreStateMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.invalid = true;
      return false;
    }
    const { type: _type, ...next } = parsed.data;
    this.snapshot = next;
    this.invalid = false;
    return true;
  }

  public get(): Readonly<SuperAgentControlPlaneGateSnapshot> {
    return this.snapshot;
  }

  /**
   * §3.6 rule 2：本 daemon 代际内唯一的 legacy 窗口。
   * `firstReadyAt` 与 `crashSignalObserved` 是必须同时满足的两条证据，缺一不可。
   */
  public isStartingWindowOpen(): boolean {
    return (
      !this.invalid &&
      this.snapshot.state === "starting" &&
      this.snapshot.firstReadyAt === null &&
      !this.snapshot.crashSignalObserved &&
      !this.snapshot.crashBudgetExhausted
    );
  }

  public requireReady(method: string): void {
    if (this.isStartingWindowOpen()) {
      throw new ControlPlaneRpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
        `${method}: control plane is still starting`,
        true,
      );
    }
    if (this.invalid || this.snapshot.state !== "ready") {
      throw new ControlPlaneRpcError(
        CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
        `${method}: control plane is not ready (state=${this.invalid ? "invalid" : this.snapshot.state}, crashSignalObserved=${this.snapshot.crashSignalObserved}, crashBudgetExhausted=${this.snapshot.crashBudgetExhausted})`,
        true,
      );
    }
  }
}

export interface SuperAgentControlPlaneCorePortOptions {
  client: Pick<ControlPlaneClient, "connect" | "request">;
  gate: SuperAgentControlPlaneGenerationGate;
  /** §2.3 同根校验：与 child 推导路径必须完全一致。 */
  tasksIndexDatabasePath: string;
  /** Core services 初始化与 tasks-index 迁移完成后恒为 true。 */
  tasksIndexReady: boolean;
}

export interface SuperAgentControlPlaneCorePort {
  readonly port: SuperAgentControlPlaneRpcPort;
  readonly gate: SuperAgentControlPlaneGenerationGate;
}

/**
 * child → Core 反向请求。除已诚实实现的 `backfill.seeds` 外，其余方法一律按
 * `proto.unimplemented` 响亮拒绝（client 侧 fail-closed，不猜字段、不伪造回执）。
 */
export async function handleSuperAgentControlPlaneInboundRequest(
  method: string,
  params: unknown,
): Promise<unknown> {
  if (method === "backfill.seeds") {
    // 解析失败即协议错误；空表表示「Core 当前没有可回填的种子」，不是伪造订阅。
    backfillSeedsParamsSchema.parse(params);
    return backfillSeedsResultSchema.parse({ seeds: [] });
  }
  throw new ControlPlaneRpcError(
    CONTROL_PLANE_RPC_ERROR_CODES.unimplemented,
    `Core has no handler for control-plane inbound method ${method}`,
    false,
  );
}

interface CachedLeaderEnsure {
  generation: number;
  result: WorkspaceEnsureResult;
}

export function createSuperAgentControlPlaneCorePort(
  options: SuperAgentControlPlaneCorePortOptions,
): SuperAgentControlPlaneCorePort {
  const { client, gate, tasksIndexDatabasePath, tasksIndexReady } = options;
  // leader ensure 按 child 代际缓存；generation 变化即视为缓存失效（不跨代际复用租约事实）。
  const leaderEnsures = new Map<string, CachedLeaderEnsure>();
  let connecting: Promise<void> | undefined;

  async function ensureConnected(): Promise<void> {
    if (!connecting) {
      connecting = client.connect().catch((error: unknown) => {
        connecting = undefined;
        throw error;
      });
    }
    await connecting;
  }

  async function ensureWorkspace(workspaceIdentity: string): Promise<WorkspaceEnsureResult> {
    const generation = gate.get().generation;
    const cached = leaderEnsures.get(workspaceIdentity);
    if (cached?.generation === generation) return cached.result;
    const result = await client.request("workspace.ensure", {
      workspaceIdentity,
      tasksIndexReady,
      tasksIndexDatabasePath,
    });
    if (result.state === "leader") {
      leaderEnsures.set(workspaceIdentity, { generation, result });
    } else {
      leaderEnsures.delete(workspaceIdentity);
    }
    return result;
  }

  const port: SuperAgentControlPlaneRpcPort = {
    async triggerIngest(
      envelope: ControlPlaneTriggerEnvelope,
    ): Promise<ControlPlaneTriggerIngestResult> {
      // §3.6 rule 2：启动窗口内的 ingest 不调 child、不进新链路，由 host 走 legacy。
      if (gate.isStartingWindowOpen()) return { handled: false };
      gate.requireReady("trigger.ingest");

      const workspaceIdentity = envelope.workspaceIdentity.trim();
      if (!workspaceIdentity) {
        // 未绑定 workspace 的 flag-on bot 不能猜测目标 plane，也不能静默 legacy 双跑。
        throw new ControlPlaneRpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.workspaceNotEnsured,
          "trigger.ingest requires a bound workspaceIdentity; bot conversation has none",
          false,
        );
      }

      await ensureConnected();
      const ensure = await ensureWorkspace(workspaceIdentity);
      // §3.6 rule 4：follower plane = 纯转发/legacy，必须计数但不写域库。
      if (ensure.state === "follower") return { handled: false };

      const result = await client.request("trigger.ingest", envelope);
      if (!result.handled) {
        // ensure 已回报 leader，child 却返回 handled=false：既不是 follower 也不是启动窗口。
        // 按 §0.3 拒绝第三种运行态，失败闭合（下一条重试会重新 ensure 并裁决）。
        leaderEnsures.delete(workspaceIdentity);
        throw new ControlPlaneRpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
          `trigger.ingest returned handled=false after leader ensure (workspace=${workspaceIdentity})`,
          true,
        );
      }
      return result;
    },

    async scheduleAudit(params: ScheduleAuditParams): Promise<{ inserted: boolean }> {
      // 调度审计没有 legacy 直路：child 未 ready 时必须释放 claim 重试，不能静默跳过。
      if (gate.isStartingWindowOpen()) {
        throw new ControlPlaneRpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
          "schedule.audit: control plane is still starting",
          true,
        );
      }
      gate.requireReady("schedule.audit");
      const workspaceIdentity = params.workspaceIdentity.trim();
      if (!workspaceIdentity) {
        throw new ControlPlaneRpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.workspaceNotEnsured,
          "schedule.audit requires a non-empty workspaceIdentity",
          false,
        );
      }
      await ensureConnected();
      const ensure = await ensureWorkspace(workspaceIdentity);
      if (ensure.state !== "leader") {
        throw new ControlPlaneRpcError(
          CONTROL_PLANE_RPC_ERROR_CODES.workspaceFailed,
          `schedule.audit requires a leader plane (workspace=${workspaceIdentity})`,
          true,
        );
      }
      return client.request("schedule.audit", params);
    },
  };

  return { port, gate };
}
