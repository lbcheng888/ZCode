/**
 * P6 OS 围栏执行器：能力探测、临时产物落盘、per-run 句柄。
 *
 * fail-closed 纪律（spec §3.4）：
 *   - 探测不确定/失败 = 不可用；prepare 抛 typed FenceStartupError；
 *   - 调用方（dispatcher）据此拒绝启动 spec run，绝不回退到协作式 env 代理；
 *   - teardown 幂等；清理失败原样上浮（保留原始错误链）。
 *
 * 残留对账：每个围栏/probe 临时目录写 owner.json（runId + pid）。prepare 启动时
 * 扫描同前缀目录：存活 pid 的其他 run 一律保留；同 runId 的存活围栏视为
 * fence.residual_conflict；死 pid / 无 owner 且超过乐观等待窗的目录回收计数。
 */
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExecutionRequest } from "@zcode/contracts";

import {
  FenceStartupError,
  fencePlatformMatrixEntry,
  type FenceCapability,
  type FenceErrorCode,
  type FenceRunStatus,
  type PrepareFenceRequest,
  type SpecFenceContract,
  type SpecFenceHandle,
} from "./contract.js";
import {
  DEFAULT_POSIX_SHELL_PATH,
  DEFAULT_SANDBOX_EXEC_PATH,
  DEFAULT_UNSHARE_PATH,
  buildDarwinFenceProfile,
  buildFencedExecutionCommand,
  buildFenceCommandPlan,
  buildLinuxFenceRuleset,
  type DarwinFenceCommandPlan,
  type FenceCommandPlan,
  type LinuxFenceCommandPlan,
} from "./command-plan.js";

const execFileAsync = promisify(execFile);

/** 探测用哨兵端口：只验证 ruleset 语法与权限，不指向真实 broker。 */
const PROBE_BROKER_PORT = 65535;
const PROBE_TIMEOUT_MS = 10_000;
/** 探测进程的临时目录 owner 标记（不是真实 run）。 */
const PROBE_RUN_ID = "__probe__";
const FENCE_DIR_PREFIX = "zcode-spec-fence-";
const FENCE_OWNER_FILE = "owner.json";
/**
 * 无 owner.json 的目录可能正处于 mkdtemp 与写 owner 之间的极窄窗口（跨进程），
 * 在此窗口内不回收，避免误删并发 run 的配置。
 */
const RESIDUAL_OWNERLESS_GRACE_MS = 60_000;
/** sandbox-exec 语义探测：连接被拒绝时脚本的退出码。 */
const PROBE_CONNECT_DENIED_EXIT = 42;

interface FenceOwnerRecord {
  runId: string;
  pid: number;
  startedAt: number;
}

interface ActiveFenceRecord extends FenceRunStatus {
  dir: string;
}

/** 本进程内活跃的围栏（status 只读面 + sweep 不误删）。 */
const activeFences = new Map<string, ActiveFenceRecord>();
/** 本进程内活跃的临时目录（含并发 probe 目录）。 */
const activeFenceDirs = new Set<string>();

export interface CreateSpecFenceOptions {
  /** 缺省 process.platform；测试可显式指定。 */
  platform?: NodeJS.Platform;
  shellPath?: string;
  unsharePath?: string;
  sandboxExecPath?: string;
  /** 启动对账回收残留后的可观测钩子（计数）；钩子抛错按启动失败处理（fail-loud）。 */
  onResidualSwept?: (result: { removed: number }) => void;
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: string }).stderr;
  const stdout = (error as Error & { stdout?: string }).stdout;
  const text = (stderr ?? "").trim() || (stdout ?? "").trim() || error.message;
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function errorExitCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}

function classifyFailure(error: unknown): { code: FenceErrorCode; detail: string } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail = errorDetail(error);
  if (code === "ENOENT") {
    return { code: "fence.startup_failed", detail: `缺少围栏依赖可执行文件: ${detail}` };
  }
  if (
    code === "EPERM" ||
    code === "EACCES" ||
    /Operation not permitted|Permission denied|permission denied/i.test(detail)
  ) {
    return { code: "fence.permission_denied", detail };
  }
  return { code: "fence.startup_failed", detail };
}

async function fileExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权发信号；其余（ESRCH 等）= 已退出。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readFenceOwner(dir: string): Promise<FenceOwnerRecord | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(dir, FENCE_OWNER_FILE), "utf8"),
    ) as Partial<FenceOwnerRecord>;
    if (
      typeof parsed.runId !== "string" ||
      typeof parsed.pid !== "number" ||
      !Number.isFinite(parsed.pid)
    ) {
      return undefined;
    }
    return {
      runId: parsed.runId,
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    };
  } catch {
    return undefined;
  }
}

async function directoryAgeMs(dir: string): Promise<number | undefined> {
  try {
    const stats = await stat(dir);
    return Date.now() - stats.mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * 创建受管临时目录并写入 owner.json。任何一步失败都向调用方上抛原始错误，
 * 由 prepare/probe 边界收敛成 typed FenceStartupError / unavailable。
 */
async function createFenceTempDir(runId: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), FENCE_DIR_PREFIX));
  activeFenceDirs.add(dir);
  try {
    const owner: FenceOwnerRecord = { runId, pid: process.pid, startedAt: Date.now() };
    await writeFile(join(dir, FENCE_OWNER_FILE), JSON.stringify(owner), "utf8");
    return dir;
  } catch (error) {
    activeFenceDirs.delete(dir);
    await rm(dir, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

/** 释放临时目录；返回清理失败细节（不把清理失败变成未捕获的 raw Error）。 */
async function releaseFenceTempDir(dir: string): Promise<string | undefined> {
  activeFenceDirs.delete(dir);
  try {
    await rm(dir, { force: true, recursive: true });
    return undefined;
  } catch (error) {
    return errorDetail(error);
  }
}

/**
 * 启动期残留对账（spec §3.4/§3.5 E7）：回收死进程留下的围栏目录。
 * 存活的其他 run 不误删；同 runId 存活 = 冲突，直接拒绝启动。
 */
async function sweepResidualFences(
  platform: NodeJS.Platform,
  currentRunId: string,
): Promise<{ removed: number }> {
  let entries;
  try {
    entries = await readdir(tmpdir(), { withFileTypes: true });
  } catch (error) {
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      `无法枚举围栏临时目录，残留状态不确定: ${errorDetail(error)}`,
      { cause: error },
    );
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(FENCE_DIR_PREFIX)) continue;
    const dir = join(tmpdir(), entry.name);
    if (activeFenceDirs.has(dir)) continue;

    const owner = await readFenceOwner(dir);
    if (owner) {
      if (owner.pid === process.pid) {
        // 同进程（可能另一 worker/模块实例）无法安全判定是否活跃：保留。
        // 进程被 kill -9 后重启时 pid 不同，死进程残留由下面的存活检查回收。
        continue;
      }
      if (isProcessAlive(owner.pid)) {
        if (owner.runId === currentRunId) {
          throw new FenceStartupError(
            "fence.residual_conflict",
            platform,
            `runId ${currentRunId} 仍被存活进程 ${owner.pid} 持有围栏`,
          );
        }
        // 其他 run 正在使用，保留。
        continue;
      }
    }
    if (!owner) {
      const age = await directoryAgeMs(dir);
      if (age !== undefined && age < RESIDUAL_OWNERLESS_GRACE_MS) {
        // 可能是并发进程刚 mkdtemp 还没写 owner，先不回收。
        continue;
      }
    }
    try {
      await rm(dir, { force: true, recursive: true });
      removed += 1;
    } catch (error) {
      throw new FenceStartupError(
        "fence.startup_failed",
        platform,
        `残留围栏目录清理失败（${dir}）: ${errorDetail(error)}`,
        { cause: error },
      );
    }
  }
  return { removed };
}

interface ProbeServer {
  server: NetServer;
  port: number;
  connections: number;
}

async function startProbeServer(): Promise<ProbeServer> {
  const state: ProbeServer = { server: createNetServer(), port: 0, connections: 0 };
  state.server.on("connection", (socket) => {
    state.connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      state.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      state.server.off("error", onError);
      resolve();
    };
    state.server.once("error", onError);
    state.server.once("listening", onListening);
    state.server.listen(0, "127.0.0.1");
  });
  const address = state.server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("围栏探测服务器端口解析失败");
  }
  state.port = address.port;
  return state;
}

async function closeProbeServer(server: NetServer | undefined): Promise<string | undefined> {
  if (!server) return undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    return undefined;
  } catch (error) {
    return errorDetail(error);
  }
}

function buildConnectProbeScript(port: number): string {
  return [
    `if exec 3<>/dev/tcp/127.0.0.1/${port}; then`,
    "  exec 3<&-",
    "  exit 0",
    "else",
    `  exit ${PROBE_CONNECT_DENIED_EXIT}`,
    "fi",
  ].join("\n");
}

/**
 * macOS 围栏语义自检（spec §3.4「探测不确定 = 拒绝」）。
 *
 * sandbox-exec 已 deprecated；只验证「能执行/能编译 profile」不足以证明
 * (deny network-outbound) 真的生效（规则可能被忽略成 no-op）。这里做正/负控制：
 *   1) 围栏外同一脚本必须能连上两个端口（证明探测手段本身可靠）；
 *   2) 围栏内放行端口必须真能连上；
 *   3) 围栏内未放行端口必须被拒（退出码 42 且没有建立连接）。
 * 任一步不符合 → 返回失败细节（调用方转 typed unavailable）。
 */
async function verifyDarwinFenceSemantics(input: {
  shellPath: string;
  sandboxExecPath: string;
  profilePath: string;
}): Promise<string | undefined> {
  let allowed: ProbeServer | undefined;
  let denied: ProbeServer | undefined;
  try {
    allowed = await startProbeServer();
    denied = await startProbeServer();
    await writeFile(input.profilePath, buildDarwinFenceProfile(allowed.port), "utf8");

    // 正控制：围栏外必须两个端口都可连接（否则 /dev/tcp 或环境本身不可用）。
    try {
      await execFileAsync(input.shellPath, ["-c", buildConnectProbeScript(allowed.port)], {
        timeout: PROBE_TIMEOUT_MS,
        encoding: "utf8",
      });
      await execFileAsync(input.shellPath, ["-c", buildConnectProbeScript(denied.port)], {
        timeout: PROBE_TIMEOUT_MS,
        encoding: "utf8",
      });
    } catch (error) {
      return `探测正控制失败（围栏外无法建立连接，无法判定围栏语义）: ${errorDetail(error)}`;
    }

    const allowedBefore = allowed.connections;
    const deniedBefore = denied.connections;

    // 负控制 1：profile 放行的端口在围栏内必须可达。
    try {
      await execFileAsync(
        input.sandboxExecPath,
        ["-f", input.profilePath, "--", input.shellPath, "-c", buildConnectProbeScript(allowed.port)],
        { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
      );
    } catch (error) {
      return `围栏内放行端口不可达（profile 语义异常）: ${errorDetail(error)}`;
    }
    if (allowed.connections <= allowedBefore) {
      return "围栏内放行端口报告成功但未真正建立连接";
    }

    // 负控制 2：未放行端口必须被内核/围栏拒绝。
    try {
      await execFileAsync(
        input.sandboxExecPath,
        ["-f", input.profilePath, "--", input.shellPath, "-c", buildConnectProbeScript(denied.port)],
        { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
      );
      return "非放行端口在围栏内连接成功：sandbox-exec 网络规则未生效（不许降级为可用）";
    } catch (error) {
      if (errorExitCode(error) !== PROBE_CONNECT_DENIED_EXIT) {
        return `非放行端口探测未得到预期拒绝（exit=${String(errorExitCode(error))}）: ${errorDetail(error)}`;
      }
    }
    if (denied.connections > deniedBefore) {
      return "非放行端口在围栏内建立了连接：sandbox-exec 网络规则未生效（不许降级为可用）";
    }
    return undefined;
  } finally {
    // 探测服务器关闭失败不改变语义结论（端口已释放或随进程退出回收）。
    await closeProbeServer(allowed?.server);
    await closeProbeServer(denied?.server);
  }
}

async function probeLinux(plan: LinuxFenceCommandPlan): Promise<FenceCapability> {
  const platform: NodeJS.Platform = "linux";
  if (!(await fileExecutable(plan.shellPath))) {
    return {
      available: false,
      platform,
      mechanism: plan.mechanism,
      code: "fence.startup_failed",
      detail: `围栏内 shell 不可执行: ${plan.shellPath}`,
    };
  }
  let dir: string | undefined;
  // fail-closed 缺省：探测未完成前一律按不可用。
  let capability: FenceCapability = {
    available: false,
    platform,
    mechanism: plan.mechanism,
    code: "fence.startup_failed",
    detail: "Linux 围栏探测未完成",
  };
  try {
    dir = await createFenceTempDir(PROBE_RUN_ID);
    const rulesetPath = join(dir, "ruleset.nft");
    await writeFile(rulesetPath, buildLinuxFenceRuleset(PROBE_BROKER_PORT), "utf8");
    // 真跑一次：unshare 建 netns → lo up → nft 载入默认拒绝规则 → /bin/true。
    // 任一步失败（user namespace 被禁、无 CAP_NET_ADMIN、ip/nft 缺失）都算不可用。
    await execFileAsync(
      plan.unsharePath,
      [
        "--net",
        "--map-root-user",
        "--fork",
        "--",
        plan.shellPath,
        "-c",
        plan.setupScript,
        "zcode-spec-fence",
        rulesetPath,
        "/bin/true",
      ],
      { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
    );
    capability = {
      available: true,
      platform,
      mechanism: plan.mechanism,
      detail:
        "unshare --net + nftables 探测通过（当前仅零 egress：宿主 127.0.0.1 上的 broker 跨新 netns 不可达，allowHosts 非空会被拒绝）",
    };
  } catch (error) {
    const failure = classifyFailure(error);
    capability = {
      available: false,
      platform,
      mechanism: plan.mechanism,
      code: failure.code,
      detail: `unshare --net/nftables 探测失败: ${failure.detail}`,
    };
  } finally {
    if (dir) {
      const cleanupFailure = await releaseFenceTempDir(dir);
      if (cleanupFailure) {
        capability.detail = `${capability.detail}；探测残留清理失败: ${cleanupFailure}`;
      }
    }
  }
  return capability;
}

async function probeDarwin(plan: DarwinFenceCommandPlan): Promise<FenceCapability> {
  const platform: NodeJS.Platform = "darwin";
  if (!(await fileExecutable(plan.sandboxExecPath))) {
    return {
      available: false,
      platform,
      mechanism: plan.mechanism,
      code: "fence.startup_failed",
      detail: `sandbox-exec 不可执行（Apple 可能已移除该已弃用工具）: ${plan.sandboxExecPath}`,
    };
  }
  if (!(await fileExecutable(plan.shellPath))) {
    return {
      available: false,
      platform,
      mechanism: plan.mechanism,
      code: "fence.startup_failed",
      detail: `围栏内 shell 不可执行: ${plan.shellPath}`,
    };
  }
  let dir: string | undefined;
  // fail-closed 缺省：探测未完成前一律按不可用。
  let capability: FenceCapability = {
    available: false,
    platform,
    mechanism: plan.mechanism,
    code: "fence.startup_failed",
    detail: "sandbox-exec 围栏探测未完成",
  };
  try {
    dir = await createFenceTempDir(PROBE_RUN_ID);
    const profilePath = join(dir, "profile.sb");
    const semanticFailure = await verifyDarwinFenceSemantics({
      shellPath: plan.shellPath,
      sandboxExecPath: plan.sandboxExecPath,
      profilePath,
    });
    capability = semanticFailure
      ? {
          available: false,
          platform,
          mechanism: plan.mechanism,
          code: "fence.startup_failed",
          detail: `sandbox-exec 围栏语义探测失败: ${semanticFailure}`,
        }
      : {
          available: true,
          platform,
          mechanism: plan.mechanism,
          deprecated: true,
          detail:
            "sandbox-exec profile 探测通过：放行端口在围栏内可达、非放行端口被拒（系统已标记 deprecated）",
        };
  } catch (error) {
    const failure = classifyFailure(error);
    capability = {
      available: false,
      platform,
      mechanism: plan.mechanism,
      code: failure.code,
      detail: `sandbox-exec 探测失败: ${failure.detail}`,
    };
  } finally {
    if (dir) {
      const cleanupFailure = await releaseFenceTempDir(dir);
      if (cleanupFailure) {
        capability.detail = `${capability.detail}；探测残留清理失败: ${cleanupFailure}`;
      }
    }
  }
  return capability;
}

async function probeCapability(
  platform: NodeJS.Platform,
  options: CreateSpecFenceOptions,
): Promise<FenceCapability> {
  const entry = fencePlatformMatrixEntry(platform);
  if (entry.mechanism === "unsupported") {
    return {
      available: false,
      platform,
      mechanism: "unsupported",
      code: "fence.unsupported_platform",
      detail: entry.notes,
    };
  }
  const plan = buildFenceCommandPlan({
    platform,
    broker: { host: "localhost", port: PROBE_BROKER_PORT },
    shellPath: options.shellPath ?? DEFAULT_POSIX_SHELL_PATH,
    unsharePath: options.unsharePath ?? DEFAULT_UNSHARE_PATH,
    sandboxExecPath: options.sandboxExecPath ?? DEFAULT_SANDBOX_EXEC_PATH,
  });
  if (plan.mechanism === "unsupported") {
    return {
      available: false,
      platform,
      mechanism: "unsupported",
      code: plan.reason,
      detail: plan.detail,
    };
  }
  return plan.platform === "linux" ? probeLinux(plan) : probeDarwin(plan);
}

async function prepareFence(
  platform: NodeJS.Platform,
  options: CreateSpecFenceOptions,
  request: PrepareFenceRequest,
): Promise<SpecFenceHandle> {
  const entry = fencePlatformMatrixEntry(platform);
  // 配置级能力门先于探测：Linux netns 的 broker 跨 namespace 不可达，非空白名单
  // 结构性无法满足（E5），必须在启动期 typed 拒绝，不能先 accept/启动再中途失败。
  if (entry.egressScope === "zero-egress-only" && (request.allowHosts?.length ?? 0) > 0) {
    throw new FenceStartupError(
      "fence.unsupported_platform",
      platform,
      `该围栏机制只支持零 egress（${entry.egressScope}）：broker 跨围栏不可达，allowHosts 非空拒绝启动（无降级）`,
    );
  }

  const capability = await probeCapability(platform, options);
  if (!capability.available) {
    throw new FenceStartupError(capability.code, platform, capability.detail);
  }

  let plan: FenceCommandPlan;
  try {
    // broker 校验（loopback/端口）由构建器负责，错误在此收敛为 typed 启动失败。
    plan = buildFenceCommandPlan({
      platform,
      broker: request.broker,
      shellPath: options.shellPath ?? DEFAULT_POSIX_SHELL_PATH,
      unsharePath: options.unsharePath ?? DEFAULT_UNSHARE_PATH,
      sandboxExecPath: options.sandboxExecPath ?? DEFAULT_SANDBOX_EXEC_PATH,
    });
  } catch (error) {
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  if (plan.mechanism === "unsupported") {
    throw new FenceStartupError(plan.reason, platform, plan.detail);
  }

  if (activeFences.has(request.runId)) {
    throw new FenceStartupError(
      "fence.residual_conflict",
      platform,
      `runId ${request.runId} 在本进程已有活跃围栏`,
    );
  }
  try {
    const swept = await sweepResidualFences(platform, request.runId);
    options.onResidualSwept?.({ removed: swept.removed });
  } catch (error) {
    if (error instanceof FenceStartupError) throw error;
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      `围栏残留对账失败: ${errorDetail(error)}`,
      { cause: error },
    );
  }

  let dir: string;
  try {
    dir = await createFenceTempDir(request.runId);
  } catch (error) {
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      `围栏临时目录创建失败: ${errorDetail(error)}`,
      { cause: error },
    );
  }

  try {
    if (plan.platform === "linux") {
      const rulesetPath = join(dir, "ruleset.nft");
      await writeFile(rulesetPath, plan.rulesetText, "utf8");
      const handle = makeHandle(request, plan, dir, { rulesetPath });
      activeFences.set(request.runId, {
        runId: request.runId,
        mechanism: plan.mechanism,
        broker: request.broker,
        pid: process.pid,
        startedAt: new Date(),
        dir,
      });
      return handle;
    }
    const profilePath = join(dir, "profile.sb");
    await writeFile(profilePath, plan.profileText, "utf8");
    const handle = makeHandle(request, plan, dir, { profilePath });
    activeFences.set(request.runId, {
      runId: request.runId,
      mechanism: plan.mechanism,
      broker: request.broker,
      pid: process.pid,
      startedAt: new Date(),
      dir,
    });
    return handle;
  } catch (error) {
    await releaseFenceTempDir(dir);
    throw new FenceStartupError(
      "fence.startup_failed",
      platform,
      `围栏临时配置落盘失败: ${errorDetail(error)}`,
      { cause: error },
    );
  }
}

function makeHandle(
  request: PrepareFenceRequest,
  plan: LinuxFenceCommandPlan | DarwinFenceCommandPlan,
  dir: string,
  artifacts: { rulesetPath?: string; profilePath?: string },
): SpecFenceHandle {
  return {
    runId: request.runId,
    mechanism: plan.mechanism,
    broker: request.broker,
    wrapExecutionRequest(execution: ExecutionRequest): ExecutionRequest {
      return {
        ...execution,
        // 执行适配器据此禁止围栏外的 login-shell snapshot / prelude（P6 §3.2）。
        internalFence: { mechanism: plan.mechanism },
        command: buildFencedExecutionCommand({
          plan,
          command: execution.command,
          artifacts,
        }),
      };
    },
    // 幂等：rm force 对已清理目录是 no-op。清理失败原样上浮（保留原始错误链）；
    // finally 从活跃表移除，后续 sweep 仍能回收这条残留。
    async teardown(): Promise<void> {
      try {
        await rm(dir, { force: true, recursive: true });
      } finally {
        activeFenceDirs.delete(dir);
        activeFences.delete(request.runId);
      }
    },
  };
}

/**
 * 创建围栏契约实现。platform 缺省 process.platform；探测/准备均在调用时执行，
 * 不做跨 run 缓存（避免把一次成功探测当成永久授权）。
 */
export function createSpecFence(options: CreateSpecFenceOptions = {}): SpecFenceContract {
  const platform = options.platform ?? process.platform;
  return {
    probeCapability: () => probeCapability(platform, options),
    prepare: (request) => prepareFence(platform, options, request),
    status: (runId: string): FenceRunStatus | undefined => {
      const active = activeFences.get(runId);
      if (!active) return undefined;
      return {
        runId: active.runId,
        mechanism: active.mechanism,
        broker: active.broker,
        pid: active.pid,
        startedAt: active.startedAt,
      };
    },
  };
}
