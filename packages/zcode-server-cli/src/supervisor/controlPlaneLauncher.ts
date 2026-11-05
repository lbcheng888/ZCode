import { spawn, type ChildProcess } from "node:child_process";
import type { ControlPlaneLaunchParams } from "../contracts.js";

/**
 * 受管 control-plane 子进程的唯一启动接口（裁决 7：daemon spawn bootstrap 组合根）。
 * Supervisor 不关心入口形态；launcher 决定命令、env 与 IPC 通道。
 */
export interface ControlPlaneLauncher {
  launch(params: ControlPlaneLaunchParams): ChildProcess;
}

export interface HeadlessControlPlaneCommand {
  executable: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/**
 * 默认 launcher：按调用方给出的 headless bootstrap 命令 spawn，并把 launch 参数经 env 传入
 * 子进程。**不猜入口路径**——headless bootstrap 入口随里程碑 B 实现；入口不存在/未注入
 * command 时调用方不得启用本 launcher，禁止向不存在的二进制假 spawn。
 *
 * 协议约定：子进程从 ipc 通道接收 `{command:"shutdown"}`，发出 ready/health/stopped
 * （见 contracts.controlPlaneMessageSchema）；generation / protocolVersion 经 env 回传。
 */
export function createControlPlaneLauncher(
  command: HeadlessControlPlaneCommand,
  baseEnv: Record<string, string | undefined> = process.env,
): ControlPlaneLauncher {
  if (!command.executable.trim()) {
    throw new Error("Control plane launcher requires a non-empty executable");
  }
  return {
    launch(params: ControlPlaneLaunchParams): ChildProcess {
      return spawn(command.executable, [...(command.args ?? [])], {
        cwd: command.cwd,
        env: {
          ...baseEnv,
          ...command.env,
          ZCODE_CONTROL_PLANE_GENERATION: String(params.generation),
          ZCODE_CONTROL_PLANE_PROTOCOL_VERSION: String(params.protocolVersion),
          ZCODE_DATA_BASE_DIR: params.dataBaseDir,
          ZCODE_SERVER_ROOT: params.serverRoot,
          ...(params.release?.releaseId
            ? { ZCODE_SERVER_RELEASE_ID: params.release.releaseId }
            : {}),
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
    },
  };
}
