import type {
  BackgroundRunKind,
  BackgroundRunOwner,
  BackgroundRunTerminalState,
  BackgroundRunTouchPatch,
} from "./contract.js";
import type { BackgroundRunRegistry } from "./registry.js";

/**
 * M8 注册钩子的投影端口（组合根接缝，spec §7-2）。
 *
 * core（background-task-registry.ts / dynamic-workflow-run-track.ts）与 services
 * （automationService / offPeakTaskService）因层方向禁令不能 import 本模块，各自在本包
 * 内声明**结构兼容子集**；组合根把本端口绑过去（core: setBackgroundRunProjection；
 * services: setter / deps 字段）。接缝缺席时钩子为 no-op，不阻塞业务路径。
 */
export interface BackgroundRunProjectionPort {
  register(row: {
    id: string;
    kind: BackgroundRunKind;
    owner: BackgroundRunOwner;
    ownerSession?: string;
    workspaceKey?: string;
    stallClockRef?: string;
    narrowResultRef?: string;
    stalledSince?: number;
    /** owner 心跳声明（spec §1.1）；core 侧仅 runtime-background-task 行传 true（spec §9）。 */
    heartbeat?: boolean;
  }): void;
  settle(
    id: string,
    owner: BackgroundRunOwner,
    state: BackgroundRunTerminalState,
    opts?: { narrowResultRef?: string },
  ): void;
  touch(id: string, owner: BackgroundRunOwner, patch: BackgroundRunTouchPatch): void;
}

/**
 * 把 registry 包成投影端口。时间戳取注入时钟（缺省 Date.now）。
 * 前置：registry 实例在；后置：端口每次调用按行级所有权规则写 registry（违例原样抛）。
 */
export function createBackgroundRunProjectionPort(
  registry: BackgroundRunRegistry,
  now: () => number = () => Date.now(),
): BackgroundRunProjectionPort {
  return {
    register(row) {
      registry.register(row, now());
    },
    settle(id, owner, state, opts) {
      registry.settle(id, owner, state, now(), opts);
    },
    touch(id, owner, patch) {
      registry.touch(id, owner, patch, now());
    },
  };
}

/**
 * 生产 workflow-only 投影：core 的 background-run 钩子同时会报 background_task 行；
 * 本切片只为 workflow 行建行（cheng 行由 S0 observer 独占），其余 kind 丢弃。
 * settle/touch 对未登记行由 registry no-op，不阻断业务路径。
 *
 * `ownerSession`/`workspaceKey` 由会话组合根补齐：core 钩子只给 run identity，
 * daemon cancel-workflow 需要 owner session 才能经 Core 投 `cancelBackgroundWork`。
 */
export function createWorkflowOnlyBackgroundRunProjection(
  registry: BackgroundRunRegistry,
  now: () => number = () => Date.now(),
  context: { ownerSession?: string; workspaceKey?: string } = {},
): BackgroundRunProjectionPort {
  const projection = createBackgroundRunProjectionPort(registry, now);
  return {
    register(row) {
      if (row.kind !== "workflow") return;
      projection.register({
        ...row,
        ...(row.ownerSession === undefined && context.ownerSession !== undefined
          ? { ownerSession: context.ownerSession }
          : {}),
        ...(row.workspaceKey === undefined && context.workspaceKey !== undefined
          ? { workspaceKey: context.workspaceKey }
          : {}),
      });
    },
    settle(id, owner, state, opts) {
      projection.settle(id, owner, state, opts);
    },
    touch(id, owner, patch) {
      projection.touch(id, owner, patch);
    },
  };
}
