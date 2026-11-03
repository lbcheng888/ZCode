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
