/**
 * would-accept 宿主缝（CLI → TUI）的能力缺席契约。
 *
 * 为什么放在 shared 而不是 @zcode/tui：CLI 的宿主查询模块同时服务于 TUI 与
 * app-server / 存储准备等无 TUI 路径；从 TUI 运行时 import 会让打包后的 agent
 * 无条件 require @zcode/tui。TUI 侧 re-export 同一个类，instanceof 身份不变。
 */
export const WOULD_ACCEPT_UNAVAILABLE_TEXT =
  "Would-accept inbox is not available in this build.";

/**
 * 宿主缝在场但能力缺席（features.eventRouter 关 / 控制面未构造）：与缝缺席走同一如实
 * unavailable 呈现。类型化分流——错误文本不作流程判据。
 */
export class WouldAcceptUnavailableError extends Error {
  constructor() {
    super(WOULD_ACCEPT_UNAVAILABLE_TEXT);
    this.name = "WouldAcceptUnavailableError";
  }
}
