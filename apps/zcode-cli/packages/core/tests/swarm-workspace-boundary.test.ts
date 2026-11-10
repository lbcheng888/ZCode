import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CoreErrorType,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTraceId,
  createTurnId,
  type AgentOutput,
  type BashOutput,
  type ExecutionResult,
  type SubagentPort,
  type SubagentRunRequest,
  type TurnId,
} from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import {
  createExploreSubagentPort,
  type ExploreSubagentRuntimeRequest,
} from "../src/subagent/runner.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { applyBashReadFileStateEffects } from "../src/tool/handlers/bash-read-file-state.js";
import { bashHandler } from "../src/tool/handlers/bash.js";
import { readHandler } from "../src/tool/handlers/read.js";
import { writeHandler, writeToolEntry } from "../src/tool/handlers/write.js";
import { resolveToolWorkingDirectory, resolveWorkspacePath } from "../src/tool/path-policy.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { SwarmWorker, type SwarmTask } from "../src/runtime/swarm/index.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

interface BoundaryFixture {
  /** 已做 realpath 的临时根：/var 与 /private/var 在 macOS 上必须收敛成同一个前缀。 */
  root: string;
  /** swarm worker 的强制边界 = 隔离工作树根。 */
  boundary: string;
  /** worker 的 cwd，位于边界内。 */
  project: string;
  /** 边界外的目录，用于越界断言。 */
  outside: string;
}

let fixture: BoundaryFixture;

beforeEach(async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zcode-swarm-boundary-")));
  const boundary = join(root, "worktree");
  const project = join(boundary, "project");
  const outside = join(root, "outside");
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "outside-secret\n", "utf8");
  fixture = { root, boundary, project, outside };
});

afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
});

function contextWith(
  options: Partial<
    Pick<ToolExecutionContext, "executionPort" | "fileSystemPort" | "runtimeScope">
  > & {
    workingDirectory?: string;
    workspaceBoundary?: string;
    workspaceRoot?: string;
    allowedWritePaths?: readonly string[];
  } = {},
): ToolExecutionContext {
  return {
    toolCallId: "tool_swarm_boundary",
    traceId: "trace_swarm_boundary",
    spanId: "span_swarm_boundary",
    abortSignal: new AbortController().signal,
    executionPort: options.executionPort,
    fileSystemPort: options.fileSystemPort,
    readFileState: new Map(),
    runtimeScope: options.runtimeScope,
    workingDirectory: options.workingDirectory ?? fixture.project,
    workspaceRoot: options.workspaceRoot ?? fixture.boundary,
    workspaceBoundary: options.workspaceBoundary,
    allowedWritePaths: options.allowedWritePaths,
    sessionId: "sess_swarm_boundary",
    turnId: "turn_swarm_boundary",
  };
}

function captureError(run: () => unknown): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error("Expected the call to throw");
}

async function captureAsyncError(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error("Expected the call to throw");
}

describe("swarm workspace boundary", () => {
  it("read and write inside the boundary succeed", async () => {
    const fileSystemPort = new MemoryFileSystem({
      [join(fixture.project, "inside.txt")]: "hello\n",
    });
    const context = contextWith({
      fileSystemPort,
      workspaceBoundary: fixture.boundary,
    });

    const readOutput = await readHandler({ file_path: "inside.txt" }, context);
    expect(readOutput).toMatchObject({
      type: "text",
      filePath: join(fixture.project, "inside.txt"),
    });
    expect(fileSystemPort.readRequests.at(-1)?.path).toBe(join(fixture.project, "inside.txt"));

    const writeOutput = await writeHandler(
      { file_path: join(fixture.project, "created.txt"), content: "created\n" },
      context,
    );
    expect(writeOutput).toMatchObject({ type: "create" });
    expect(fileSystemPort.files[join(fixture.project, "created.txt")]).toBe("created\n");
  });

  it("enforces a file-domain write allowlist without restricting reads", async () => {
    const allowed = join(fixture.project, "allowed-new.txt");
    const other = join(fixture.project, "other.txt");
    const fileSystemPort = new MemoryFileSystem({
      [other]: "other\n",
    });
    const context = contextWith({
      fileSystemPort,
      allowedWritePaths: [allowed],
    });

    const writeAllowed = await writeHandler({ file_path: allowed, content: "updated\n" }, context);
    expect(writeAllowed).toMatchObject({ type: "create" });
    expect(fileSystemPort.files[allowed]).toBe("updated\n");

    const writeOutside = await captureAsyncError(() =>
      writeHandler({ file_path: other, content: "nope\n" }, context),
    );
    expect(writeOutside).toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      recoverable: true,
      context: { allowedWritePathCount: 1 },
    });
    expect(writeOutside.message).toContain("outside the AgentSwarm file domain");
    expect(fileSystemPort.files[other]).toBe("other\n");

    // 读不受写域限制：worker 需要读取领域外的上下文。
    const readOutside = await readHandler({ file_path: other }, context);
    expect(readOutside).toMatchObject({ type: "text", filePath: other });
  });

  it("rejects `../` escapes from the working directory", async () => {
    const fileSystemPort = new MemoryFileSystem({});
    const context = contextWith({
      fileSystemPort,
      workspaceBoundary: fixture.boundary,
    });

    const error = await captureAsyncError(() =>
      readHandler({ file_path: "../../outside/secret.txt" }, context),
    );

    expect(error).toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      recoverable: true,
      context: { boundary: fixture.boundary },
    });
    expect(error.message).toContain(fixture.boundary);
    expect(error.message).toContain(join(fixture.outside, "secret.txt"));
    expect(fileSystemPort.readRequests).toHaveLength(0);
  });

  it("rejects absolute paths outside the boundary", async () => {
    const fileSystemPort = new MemoryFileSystem({});
    const context = contextWith({
      fileSystemPort,
      workspaceBoundary: fixture.boundary,
    });

    const error = await captureAsyncError(() =>
      writeHandler({ file_path: join(fixture.outside, "escaped.txt"), content: "nope\n" }, context),
    );

    expect(error).toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      context: { boundary: fixture.boundary, path: join(fixture.outside, "escaped.txt") },
    });
    expect(fileSystemPort.files[join(fixture.outside, "escaped.txt")]).toBeUndefined();
  });

  it("rejects symlinks that resolve outside the boundary", async () => {
    await symlink(fixture.outside, join(fixture.boundary, "escape-link"), "dir");
    await symlink(join(fixture.outside, "secret.txt"), join(fixture.boundary, "secret-link.txt"));
    const fileSystemPort = new MemoryFileSystem({});
    const context = contextWith({
      fileSystemPort,
      workspaceBoundary: fixture.boundary,
    });

    const viaDirectory = await captureAsyncError(() =>
      readHandler({ file_path: join(fixture.boundary, "escape-link", "secret.txt") }, context),
    );
    expect(viaDirectory).toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      context: { path: join(fixture.outside, "secret.txt") },
    });

    const viaFile = await captureAsyncError(() =>
      readHandler({ file_path: join(fixture.boundary, "secret-link.txt") }, context),
    );
    expect(viaFile).toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      context: { path: join(fixture.outside, "secret.txt") },
    });

    const writeViaDirectory = await captureAsyncError(() =>
      writeHandler(
        { file_path: join(fixture.boundary, "escape-link", "escaped.txt"), content: "nope\n" },
        context,
      ),
    );
    expect(writeViaDirectory).toMatchObject({ type: CoreErrorType.ToolExecutionFailed });
    expect(fileSystemPort.files[join(fixture.outside, "escaped.txt")]).toBeUndefined();
    expect(fileSystemPort.readRequests).toHaveLength(0);
  });

  it("rejects symlink chains whose dangling or existing target escapes the boundary", async () => {
    const options = {
      operation: "write" as const,
      workingDirectory: fixture.project,
      workspaceRoot: fixture.boundary,
      workspaceBoundary: fixture.boundary,
    };
    // 已存在的 target：realpath 会直接展开到边界外。
    await symlink(fixture.outside, join(fixture.boundary, "existing-link"), "dir");
    expect(
      captureError(() =>
        resolveWorkspacePath({
          ...options,
          inputPath: join(fixture.boundary, "existing-link", "escaped.txt"),
        }),
      ),
    ).toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      context: { path: join(fixture.outside, "escaped.txt") },
    });

    // dangling target：目标目录尚不存在，也不能被当成“不存在的尾段”放行。
    const danglingTarget = join(fixture.outside, "missing-dir");
    await symlink(danglingTarget, join(fixture.boundary, "dangling-link"), "dir");
    expect(
      captureError(() =>
        resolveWorkspacePath({
          ...options,
          inputPath: join(fixture.boundary, "dangling-link", "escaped.txt"),
        }),
      ),
    ).toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      context: { path: join(danglingTarget, "escaped.txt") },
    });

    // 相对 target 按 symlink 父目录解析；同样不能借 dangling 链越界。
    await mkdir(join(fixture.boundary, "links"), { recursive: true });
    await symlink("../../outside/missing-dir", join(fixture.boundary, "links", "rel-dangling"));
    expect(
      captureError(() =>
        resolveWorkspacePath({
          ...options,
          inputPath: join(fixture.boundary, "links", "rel-dangling", "escaped.txt"),
        }),
      ),
    ).toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      context: { path: join(danglingTarget, "escaped.txt") },
    });

    // 循环链必须 fail-closed，不能无限解析。
    await symlink("loop-b", join(fixture.boundary, "loop-a"));
    await symlink("loop-a", join(fixture.boundary, "loop-b"));
    expect(
      captureError(() =>
        resolveWorkspacePath({
          ...options,
          inputPath: join(fixture.boundary, "loop-a", "escaped.txt"),
        }),
      ),
    ).toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      context: { link: join(fixture.boundary, "loop-a") },
    });

    // dangling target 仍在边界内时照常放行：解析后是边界内尚不存在的新路径。
    await symlink("future-dir", join(fixture.boundary, "inside-dangling"));
    expect(
      resolveWorkspacePath({
        ...options,
        inputPath: join(fixture.boundary, "inside-dangling", "new.txt"),
      }),
    ).toBe(join(fixture.boundary, "future-dir", "new.txt"));
  });

  it("allows 40 symlink hops and fails closed beyond the resolution limit", async () => {
    const options = {
      operation: "write" as const,
      workingDirectory: fixture.project,
      workspaceRoot: fixture.boundary,
      workspaceBoundary: fixture.boundary,
    };
    // 40 跳是上限内：每一跳解析到同目录下一条链，最终落在边界内的真实文件。
    for (let index = 0; index < 40; index += 1) {
      await symlink(`allowed-${index + 1}`, join(fixture.boundary, `allowed-${index}`));
    }
    await writeFile(join(fixture.boundary, "allowed-40"), "end\n", "utf8");
    expect(
      resolveWorkspacePath({ ...options, inputPath: join(fixture.boundary, "allowed-0") }),
    ).toBe(join(fixture.boundary, "allowed-40"));

    // 第 41 跳越过上限：不猜最终目标，按 ToolExecutionFailed 停住。
    for (let index = 0; index <= 40; index += 1) {
      await symlink(`deep-${index + 1}`, join(fixture.boundary, `deep-${index}`));
    }
    await writeFile(join(fixture.boundary, "deep-41"), "end\n", "utf8");
    expect(
      captureError(() =>
        resolveWorkspacePath({ ...options, inputPath: join(fixture.boundary, "deep-0") }),
      ),
    ).toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      context: { maxSymlinkResolutions: 40 },
    });
  });

  it("rejects a Bash cwd outside the boundary before spawning", async () => {
    const requests: unknown[] = [];
    const executionPort = {
      async run(request: unknown): Promise<ExecutionResult> {
        requests.push(request);
        return executionResult();
      },
    };
    const context = contextWith({
      executionPort,
      workingDirectory: fixture.outside,
      workspaceBoundary: fixture.boundary,
    });

    const error = await captureAsyncError(() => bashHandler({ command: "echo hi" }, context));

    expect(requests).toHaveLength(0);
    expect(error).toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      context: { boundary: fixture.boundary, path: fixture.outside },
    });
  });

  it("fails closed when the boundary is invalid", () => {
    const options = {
      inputPath: join(fixture.project, "inside.txt"),
      operation: "read" as const,
      workingDirectory: fixture.project,
      workspaceRoot: fixture.boundary,
    };

    expect(
      captureError(() => resolveWorkspacePath({ ...options, workspaceBoundary: "" })),
    ).toMatchObject({ type: CoreErrorType.ConfigurationError });
    expect(
      captureError(() =>
        resolveWorkspacePath({ ...options, workspaceBoundary: "relative/worktree" }),
      ),
    ).toMatchObject({ type: CoreErrorType.ConfigurationError });
    expect(
      captureError(() =>
        resolveWorkspacePath({ ...options, workspaceBoundary: join(fixture.root, "missing") }),
      ),
    ).toMatchObject({ type: CoreErrorType.ConfigurationError });
    // 边界必须是目录：文件名不能当狱墙。
    expect(
      captureError(() =>
        resolveWorkspacePath({
          ...options,
          workspaceBoundary: join(fixture.outside, "secret.txt"),
        }),
      ),
    ).toMatchObject({ type: CoreErrorType.ConfigurationError });
  });

  it("keeps the pre-boundary behavior when the boundary is absent", async () => {
    const outsideFile = join(fixture.outside, "secret.txt");
    // 普通会话：workspaceRoot 外的路径照旧放行（现行语义），不做 realpath 规范化。
    expect(
      resolveWorkspacePath({
        inputPath: outsideFile,
        operation: "read",
        workingDirectory: fixture.project,
        workspaceRoot: fixture.boundary,
      }),
    ).toBe(outsideFile);
    expect(
      resolveToolWorkingDirectory(undefined, {
        operation: "execute",
        workingDirectory: fixture.outside,
        workspaceRoot: fixture.boundary,
      }),
    ).toBe(fixture.outside);

    const fileSystemPort = new MemoryFileSystem({ [outsideFile]: "outside\n" });
    const readOutput = await readHandler(
      { file_path: outsideFile },
      contextWith({ fileSystemPort }),
    );
    expect(readOutput).toMatchObject({ type: "text", filePath: outsideFile });
    expect(fileSystemPort.readRequests.at(-1)?.path).toBe(outsideFile);

    const requests: Array<{ cwd?: string }> = [];
    const executionPort = {
      async run(request: { cwd?: string }): Promise<ExecutionResult> {
        requests.push(request);
        return executionResult();
      },
    };
    await bashHandler(
      { command: "echo hi" },
      contextWith({
        executionPort,
        workingDirectory: fixture.outside,
        workspaceRoot: fixture.boundary,
      }),
    );
    expect(requests[0]?.cwd).toBe(fixture.outside);
  });

  it("fails closed when Bash read-state backfill resolves outside the boundary", async () => {
    const insideFile = join(fixture.project, "inside.txt");
    await writeFile(insideFile, "inside\n", "utf8");
    const fileSystemPort = new MemoryFileSystem({ [insideFile]: "inside\n" });
    const context = contextWith({ fileSystemPort, workspaceBoundary: fixture.boundary });

    await applyBashReadFileStateEffects({
      command: `cat ${insideFile}`,
      context,
      output: bashOutput(),
      result: executionResult(),
    });
    expect(context.readFileState.has(insideFile)).toBe(true);

    // 命令执行后回填同样按边界 fail-closed：越界路径不能被静默跳过。
    const error = await captureAsyncError(() =>
      applyBashReadFileStateEffects({
        command: `cat ${join(fixture.outside, "secret.txt")}`,
        context,
        output: bashOutput(),
        result: executionResult(),
      }),
    );
    expect(error).toMatchObject({
      type: CoreErrorType.ToolExecutionFailed,
      recoverable: true,
      context: { boundary: fixture.boundary },
    });
  });

  it("enforces the boundary through the production executor", async () => {
    const sessionId = createSessionId("boundary-executor");
    const turnId = createTurnId("boundary-executor");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    registry.register(writeToolEntry);
    const fileSystemPort = new MemoryFileSystem({});
    const executor = createToolExecutor({
      emitEvent: async () => {},
      fileSystemPort,
      getWorkspaceBoundary: () => fixture.boundary,
      mode: "yolo",
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      traceContext,
      turnId,
      workingDirectory: fixture.project,
      workspaceRoot: fixture.boundary,
    });

    const inside = await executor.execute(
      {
        id: createToolCallId("boundary-inside"),
        input: { file_path: join(fixture.project, "inside.txt"), content: "inside\n" },
        name: "Write",
      },
      { traceContext },
    );
    expect(inside.success).toBe(true);
    expect(fileSystemPort.files[join(fixture.project, "inside.txt")]).toBe("inside\n");

    const escapedFile = join(fixture.outside, "escaped.txt");
    const escaped = await executor.execute(
      {
        id: createToolCallId("boundary-outside"),
        input: { file_path: escapedFile, content: "nope\n" },
        name: "Write",
      },
      { traceContext },
    );
    expect(escaped.success).toBe(false);
    expect(escaped.error?.type).toBe(CoreErrorType.ToolExecutionFailed);
    expect(escaped.error?.message).toContain(fixture.boundary);
    expect(fileSystemPort.files[escapedFile]).toBeUndefined();
  });

  it("swarm worker requests carry the isolated worktree root as boundary", async () => {
    const requests: SubagentRunRequest[] = [];
    const parentSessionId = createSessionId("parent-session");
    const port: SubagentPort = {
      async launch() {
        throw new Error("SwarmWorker must not call launch()");
      },
      async run(request): Promise<AgentOutput> {
        requests.push(request);
        return {
          status: "completed",
          agentId: "agent-1",
          agentType: request.agentType,
          description: request.description,
          prompt: request.prompt,
          content: [{ type: "text", text: "done" }],
          totalToolUseCount: 0,
          totalDurationMs: 1,
        };
      },
    };
    const task: SwarmTask = {
      taskId: "subtask-boundary",
      agentType: "general-purpose",
      description: "boundary check",
      prompt: "check the worktree boundary",
      status: "pending",
      sessionId: parentSessionId,
      turnId: "turn-1" as TurnId,
      parentToolCallId: "tool-call-1",
      workingDirectory: fixture.project,
      workspaceRoot: fixture.boundary,
      // 编排层建好隔离树后显式写入边界；worker 不再从 workspaceRoot 推导。
      workspaceBoundary: fixture.boundary,
      allowedWritePaths: [join(fixture.project, "lane.ts")],
      trace: { traceId: createTraceId(), sessionId: parentSessionId },
    };

    await new SwarmWorker(port).execute(task);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.workspaceBoundary).toBe(fixture.boundary);
    expect(requests[0]?.allowedWritePaths).toEqual([join(fixture.project, "lane.ts")]);
    expect(requests[0]?.workingDirectory).toBe(fixture.project);
  });

  it("resumes a terminal swarm worker with the original worktree boundary", async () => {
    const requests: ExploreSubagentRuntimeRequest[] = [];
    const port = createExploreSubagentPort({
      outputRootDir: join(fixture.root, "agents"),
      emitParentEvent: async () => {},
      runExploreAgent: async (request) => {
        requests.push(request);
        return {
          response: "done",
          traceId: request.traceContext.traceId,
          events: [],
        };
      },
    });
    const sessionId = createSessionId("resume-boundary");
    const trace = { traceId: createTraceId(), sessionId };

    const first = await port.run({
      sessionId,
      agentType: "general-purpose",
      description: "boundary task",
      parentToolCallId: "first",
      prompt: "check the worktree",
      workingDirectory: fixture.project,
      workspaceRoot: fixture.project,
      workspaceBoundary: fixture.boundary,
      allowedWritePaths: [join(fixture.project, "resume-lane.ts")],
      trace,
    });
    if (first.status !== "completed") throw new Error("expected the first run to complete");

    const resumed = await port.sendMessage!({
      sessionId,
      to: first.agentId,
      message: "continue",
      parentToolCallId: "resume",
      // 发送方 cwd 故意在边界外：resume 的边界只能来自原 task snapshot。
      workingDirectory: fixture.outside,
      workspaceRoot: fixture.outside,
      trace,
    });
    expect(resumed.delivery).toBe("resumed_background");
    await port.waitForTask!(first.agentId);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.workspaceBoundary).toBe(fixture.boundary);
    expect(requests[1]?.allowedWritePaths).toEqual([join(fixture.project, "resume-lane.ts")]);
    // 恢复沿用原任务 cwd，而不是发送方故意放在界外的 cwd。
    expect(requests[1]?.workingDirectory).toBe(fixture.project);
    await port.close();
  });

  it("refuses to resume a swarm worker after its worktree is disposed", async () => {
    const requests: ExploreSubagentRuntimeRequest[] = [];
    const port = createExploreSubagentPort({
      outputRootDir: join(fixture.root, "agents-disposed"),
      emitParentEvent: async () => {},
      runExploreAgent: async (request) => {
        requests.push(request);
        return {
          response: "done",
          traceId: request.traceContext.traceId,
          events: [],
        };
      },
    });
    const sessionId = createSessionId("resume-disposed");
    const trace = { traceId: createTraceId(), sessionId };

    const first = await port.run({
      sessionId,
      agentType: "general-purpose",
      description: "disposed boundary task",
      parentToolCallId: "first-disposed",
      prompt: "check the worktree",
      workingDirectory: fixture.project,
      workspaceRoot: fixture.project,
      workspaceBoundary: fixture.boundary,
      trace,
    });
    if (first.status !== "completed") throw new Error("expected the first run to complete");

    await rm(fixture.boundary, { recursive: true, force: true });
    const resumed = await port.sendMessage!({
      sessionId,
      to: first.agentId,
      message: "continue",
      parentToolCallId: "resume-disposed",
      workingDirectory: fixture.outside,
      workspaceRoot: fixture.outside,
      trace,
    });

    expect(resumed.status).toBe("failed");
    expect(resumed.error).toContain("worktree was disposed");
    // 失败的 resume 不得启动第二个 child runtime。
    expect(requests).toHaveLength(1);
    await port.close();
  });

  it("keeps workspaceBoundary absent when the original agent had none", async () => {
    const requests: ExploreSubagentRuntimeRequest[] = [];
    const port = createExploreSubagentPort({
      outputRootDir: join(fixture.root, "agents-plain"),
      emitParentEvent: async () => {},
      runExploreAgent: async (request) => {
        requests.push(request);
        return {
          response: "done",
          traceId: request.traceContext.traceId,
          events: [],
        };
      },
    });
    const sessionId = createSessionId("resume-plain");
    const trace = { traceId: createTraceId(), sessionId };

    const first = await port.run({
      sessionId,
      agentType: "general-purpose",
      description: "plain task",
      parentToolCallId: "first",
      prompt: "plain run",
      workingDirectory: fixture.project,
      workspaceRoot: fixture.project,
      trace,
    });
    if (first.status !== "completed") throw new Error("expected the first run to complete");

    await port.sendMessage!({
      sessionId,
      to: first.agentId,
      message: "continue",
      parentToolCallId: "resume",
      workingDirectory: fixture.project,
      workspaceRoot: fixture.project,
      trace,
    });
    await port.waitForTask!(first.agentId);

    // 普通子代理没有强制边界：snapshot 与恢复请求都必须保持缺席。
    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toHaveProperty("workspaceBoundary");
    expect(requests[1]).not.toHaveProperty("workspaceBoundary");
    await port.close();
  });

  it("wires AgentRuntimeConfig.workspaceBoundary through runtime-tools into tool execution", async () => {
    const sessionId = createSessionId("boundary-runtime-config");
    const traceContext = createRootTraceContext({ sessionId });
    const fileSystemPort = new MemoryFileSystem({});
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        workingDirectory: fixture.project,
        workspaceBoundary: fixture.boundary,
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort,
      },
    );
    const escapedFile = join(fixture.outside, "runtime-escaped.txt");
    const call = {
      id: createToolCallId("runtime-boundary-write"),
      name: "Write",
      input: { file_path: escapedFile, content: "nope\n" },
    };
    const schedule = await runtime.scheduleTools([call]);
    const execution = await runtime.executeTools([call], schedule, { traceContext });

    expect(execution.results[0]?.success).toBe(false);
    expect(execution.results[0]?.error?.type).toBe(CoreErrorType.ToolExecutionFailed);
    expect(fileSystemPort.files[escapedFile]).toBeUndefined();
  });

  it("wires AgentRuntimeConfig.allowedWritePaths through runtime-tools into Write", async () => {
    const sessionId = createSessionId("file-domain-runtime-config");
    const traceContext = createRootTraceContext({ sessionId });
    const fileSystemPort = new MemoryFileSystem({});
    const allowed = join(fixture.project, "allowed.ts");
    const outside = join(fixture.project, "outside.ts");
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        workingDirectory: fixture.project,
        allowedWritePaths: [allowed],
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort,
      },
    );
    const outsideCall = {
      id: createToolCallId("runtime-file-domain-outside"),
      name: "Write",
      input: { file_path: outside, content: "nope\n" },
    };
    const schedule = await runtime.scheduleTools([outsideCall]);
    const execution = await runtime.executeTools([outsideCall], schedule, { traceContext });

    expect(execution.results[0]?.success).toBe(false);
    expect(execution.results[0]?.error?.type).toBe(CoreErrorType.ToolExecutionFailed);
    expect(fileSystemPort.files[outside]).toBeUndefined();

    const allowedCall = {
      id: createToolCallId("runtime-file-domain-allowed"),
      name: "Write",
      input: { file_path: allowed, content: "ok\n" },
    };
    const allowedSchedule = await runtime.scheduleTools([allowedCall]);
    const allowedExecution = await runtime.executeTools([allowedCall], allowedSchedule, {
      traceContext,
    });
    expect(allowedExecution.results[0]?.success).toBe(true);
    expect(fileSystemPort.files[allowed]).toBe("ok\n");
  });

  it("wires SubagentRunRequest.workspaceBoundary into the child runtime config", async () => {
    const sessionId = createSessionId("boundary-child-runtime");
    const traceContext = createRootTraceContext({ sessionId });
    const escapedFile = join(fixture.outside, "child-escaped.txt");
    const fileSystemPort = new MemoryFileSystem({});
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        workingDirectory: fixture.project,
        subagents: { enabled: true },
      },
      {
        eventStore,
        fileSystemPort,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            const hasToolResult = request.messages.some((message) => message.role === "tool");
            if (!hasToolResult) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "child-write-outside",
                    name: "Write",
                    input: { file_path: escapedFile, content: "nope\n" },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    const subagentPort = (runtime as unknown as { subagentPort: SubagentPort }).subagentPort;

    const result = await subagentPort.run({
      sessionId,
      agentType: "general-purpose",
      description: "child boundary",
      parentToolCallId: "child-boundary",
      prompt: "write outside the isolated worktree",
      workingDirectory: fixture.project,
      workspaceRoot: fixture.project,
      workspaceBoundary: fixture.boundary,
      trace: traceContext,
    });

    expect(result.status).toBe("completed");
    // 边界沿 child runtime 生效：Write 在 MemoryFileSystem 上也没有落到边界外。
    expect(fileSystemPort.files[escapedFile]).toBeUndefined();
    // 还必须是「真的尝试过并被拒绝」，而不是模型根本没发起 Write。
    const childTask = await subagentPort.getTask?.(result.agentId);
    const childEvents = childTask?.childSessionId
      ? await eventStore.getEvents(childTask.childSessionId)
      : [];
    expect(childEvents.some((event) => event.type === SessionEventType.ToolCallError)).toBe(true);
  });

  it("wires SubagentRunRequest.allowedWritePaths into the child runtime config", async () => {
    const sessionId = createSessionId("file-domain-child-runtime");
    const traceContext = createRootTraceContext({ sessionId });
    const allowedFile = join(fixture.project, "child-allowed.ts");
    const escapedFile = join(fixture.project, "child-outside.ts");
    const fileSystemPort = new MemoryFileSystem({});
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        workingDirectory: fixture.project,
        subagents: { enabled: true },
      },
      {
        eventStore,
        fileSystemPort,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            const hasToolResult = request.messages.some((message) => message.role === "tool");
            if (!hasToolResult) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "child-write-outside-domain",
                    name: "Write",
                    input: { file_path: escapedFile, content: "nope\n" },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    const subagentPort = (runtime as unknown as { subagentPort: SubagentPort }).subagentPort;

    const result = await subagentPort.run({
      sessionId,
      agentType: "general-purpose",
      description: "child file domain",
      parentToolCallId: "child-file-domain",
      prompt: "write outside the file domain",
      workingDirectory: fixture.project,
      workspaceRoot: fixture.project,
      allowedWritePaths: [allowedFile],
      trace: traceContext,
    });

    expect(result.status).toBe("completed");
    expect(fileSystemPort.files[escapedFile]).toBeUndefined();
    const childTask = await subagentPort.getTask?.(result.agentId);
    const childEvents = childTask?.childSessionId
      ? await eventStore.getEvents(childTask.childSessionId)
      : [];
    expect(childEvents.some((event) => event.type === SessionEventType.ToolCallError)).toBe(true);
  });
});

function bashOutput(): BashOutput {
  return {
    stdout: "",
    stderr: "",
    status: "completed",
    exitCode: 0,
    interrupted: false,
    isImage: false,
  };
}

function executionResult(): ExecutionResult {
  const now = new Date();
  return {
    status: "completed",
    exitCode: 0,
    stdout: { text: "", bytes: 0, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAt: now,
    completedAt: now,
  };
}
