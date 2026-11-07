/**
 * 真实子进程 fixture：启动 headless control-plane daemon（真实 sqlite + 真实 socket +
 * 真实 IPC）。仅测试使用。
 *
 * peer 门是测试替身：真实 peer credential 解析需要原生绑定（见 peerIdentity.ts 诚实
 * 边界），这里用固定 PID resolver 证明「可信/不可信集合」的判定路径与断连计数。
 */
import {
  createControlPlanePeerGuard,
  type PeerIdentity,
  type PeerIdentityResolver,
} from "../../../src/super-agent/daemon/peerIdentity.js";
import { startControlPlaneDaemon } from "../../../src/app/super-agent-daemon-entry.js";

const trustedPid = Number(process.env.TEST_TRUSTED_PID);
const rejectAll = process.env.TEST_REJECT_PEER === "1";
const authTokenFile = process.env.TEST_AUTH_TOKEN_FILE;
const noAuth = process.env.TEST_NO_AUTH === "1";
const healthIntervalMs = Number(process.env.TEST_HEALTH_INTERVAL_MS) || undefined;
const dispatchIntervalMs = Number(process.env.TEST_DISPATCH_INTERVAL_MS) || undefined;
const dispatchGraceMs = Number(process.env.TEST_DISPATCH_GRACE_MS) || undefined;
// E2E 用真实 watchdog 跨进程 repair：缩短 tick/熔断参数（生产缺省 DEFAULT_WATCHDOG_CONFIG）。
const watchdogTickMs = Number(process.env.TEST_WATCHDOG_TICK_MS) || undefined;
const watchdogEscalationThreshold =
  Number(process.env.TEST_WATCHDOG_ESCALATION_THRESHOLD) || undefined;
const watchdogEscalationCooldownMs =
  Number(process.env.TEST_WATCHDOG_ESCALATION_COOLDOWN_MS) || undefined;

const resolver: PeerIdentityResolver = {
  async resolve(): Promise<PeerIdentity> {
    if (rejectAll) return { kind: "unavailable", reason: "test: peer credentials unavailable" };
    return { kind: "resolved", pid: trustedPid, uid: process.getuid?.() ?? 0 };
  },
};

const config = {
  generation: Number(process.env.ZCODE_CONTROL_PLANE_GENERATION),
  protocolVersion: Number(process.env.ZCODE_CONTROL_PLANE_PROTOCOL_VERSION),
  dataBaseDir: process.env.ZCODE_DATA_BASE_DIR ?? "",
  serverRoot: process.env.ZCODE_SERVER_ROOT ?? "",
  mandateGate: false,
  peerMode: process.env.TEST_PEER_MODE === "1",
};

void (async () => {
  const daemon = await startControlPlaneDaemon({
    config,
    ...(healthIntervalMs ? { healthIntervalMs } : {}),
    ...(dispatchIntervalMs ? { dispatchIntervalMs } : {}),
    ...(dispatchGraceMs ? { dispatchGraceMs } : {}),
    ...(watchdogTickMs || watchdogEscalationThreshold || watchdogEscalationCooldownMs
      ? {
          watchdogConfig: {
            ...(watchdogTickMs ? { tickIntervalMs: watchdogTickMs } : {}),
            ...(watchdogEscalationThreshold
              ? { escalationFailureThreshold: watchdogEscalationThreshold }
              : {}),
            ...(watchdogEscalationCooldownMs
              ? { escalationCooldownMs: watchdogEscalationCooldownMs }
              : {}),
          },
        }
      : {}),
    // §3.8 生产路径：凭据文件认证；只有未提供凭据的用例才退到测试 peer 门。
    // TEST_NO_AUTH 用于断言「既无凭据又无 peer 门 → 拒绝绑定」的 fail-closed 路径。
    ...(authTokenFile
      ? { authTokenFile }
      : noAuth
        ? {}
        : { peerGuard: createControlPlanePeerGuard({ trustedPids: [trustedPid], resolver }) }),
    send: (message) => {
      process.send?.(message);
    },
    subscribeShutdownCommand: (listener) => {
      process.on("message", (raw: unknown) => {
        if (
          typeof raw === "object" &&
          raw !== null &&
          (raw as { command?: unknown }).command === "shutdown"
        ) {
          listener();
        }
      });
    },
    subscribeParentDisconnect: (listener) => {
      process.once("disconnect", listener);
    },
    onError: (error, context) => {
      // 测试可观测的自定义消息（不属于生命周期 schema，只走 IPC 供断言读取）。
      process.send?.({
        type: "test-error",
        context,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const code = await daemon.done;
  process.exit(code);
})();
