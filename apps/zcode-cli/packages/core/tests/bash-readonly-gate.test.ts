import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type ExecutionPort,
  type ExecutionResult,
  type SessionEvent,
} from "@zcode/contracts";
import { PermissionService } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { resolveRuntimePermissionCapability } from "../src/tool/executor/permission-capability.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { isRuntimeReadOnlyBashCommand } from "../src/tool/handlers/bash-semantics.js";
import { createToolRegistry } from "../src/tool/registry.js";

/**
 * 写前最佳方案门禁（call-runner bestPlanGate 段）对 Bash 的只读判定回归。
 * 门禁本身只消费 resolveBashPermissionCapability 的能力旗标（readOnly/sideEffectScope），
 * 旗标为 undefined 时回落 entry.metadata.sideEffectScope（Bash=system）→ 拦截。
 * 所以「可证明只读的命令必须判 readOnly:true」就是门禁不误拦的充分条件。
 */

// 真实误拦案例：长程回合里被 best-plan 门禁打断的调查命令。
const FALSE_POSITIVE_COMMANDS = [
  `rg -ln "read.?only" a.ts b.ts 2>/dev/null | head -5; rg -n "sed" bash.ts | head -10`,
  `rg -rn "pattern" src`,
  `grep -c "x" file`,
];

function capabilityFlags(command: string): { readOnly?: boolean; sideEffectScope?: string } {
  const capability = resolveRuntimePermissionCapability(
    bashToolEntry,
    { command },
    { bashShellSelection: { dialect: "posix", source: "user-config", display: { name: "zsh" } } },
  );
  return { readOnly: capability?.readOnly, sideEffectScope: capability?.sideEffectScope };
}

describe("bash readonly gate regression", () => {
  it.each(FALSE_POSITIVE_COMMANDS)("classifies real-world investigation as read-only: %s", (command) => {
    expect(isRuntimeReadOnlyBashCommand(command)).toBe(true);
    // 门禁真实消费入口：旗标必须给出 readOnly:true / sideEffectScope:"none"，
    // 否则 toolRequiresBestPlan 回落 Bash metadata（system）把只读调查拦下。
    expect(capabilityFlags(command)).toEqual({ readOnly: true, sideEffectScope: "none" });
  });

  it.each([
    `rg -rn "pattern" src`,
    `rg -r X pattern src`,
    `rg --replace X pattern src`,
    `rg --replace=X pattern src`,
  ])("treats rg -r/--replace as stdout-only rewrite: %s", (command) => {
    expect(isRuntimeReadOnlyBashCommand(command)).toBe(true);
    expect(capabilityFlags(command)).toEqual({ readOnly: true, sideEffectScope: "none" });
  });

  it("keeps stderr-only redirects side-effect free in a sequence chain", () => {
    expect(isRuntimeReadOnlyBashCommand(`rg -n "foo" src 2>/dev/null`)).toBe(true);
    expect(isRuntimeReadOnlyBashCommand(`rg -n "foo" src 2>/dev/null; grep -c "bar" file`)).toBe(
      true,
    );
    // stdout 落 /dev/null 同样无文件副作用（既有设计，锁定防回归）。
    expect(isRuntimeReadOnlyBashCommand(`rg -n "foo" src > /dev/null`)).toBe(true);
  });

  it("still fails closed for real side effects", () => {
    // sed -i 原地改文件（rg -r 与之不同，只改 stdout 输出）。
    expect(isRuntimeReadOnlyBashCommand(`sed -i "s/a/b/" file.txt`)).toBe(false);
    expect(isRuntimeReadOnlyBashCommand(`rm -rf build`)).toBe(false);
    // 写重定向产生文件副作用。
    expect(isRuntimeReadOnlyBashCommand(`rg "pattern" src > out.txt`)).toBe(false);
    expect(isRuntimeReadOnlyBashCommand(`echo hi >> log.txt`)).toBe(false);
    // rg --pre 会执行任意预处理命令，未列入安全 flags，必须 fail-closed。
    expect(isRuntimeReadOnlyBashCommand(`rg --pre "gzip -d" pattern src`)).toBe(false);
  });

  it("still fails closed for unprovable syntax and unknown binaries", () => {
    // 未知二进制：分类器无法证明只读（fail-closed 是设计取舍，不是本轮误拦）。
    expect(isRuntimeReadOnlyBashCommand(`totally-unknown-binary-xyz file`)).toBe(false);
    // 命令替换会在主命令前执行，不能按字面 argv 放行。
    expect(isRuntimeReadOnlyBashCommand(`rg $(cat pattern.txt) src`)).toBe(false);
    expect(isRuntimeReadOnlyBashCommand(`rg "unclosed`)).toBe(false);
    // 分类器拒绝时 resolveBashPermissionCapability 返回 undefined，合并结果回落
    // entry.metadata（readOnly:false / sideEffectScope:"system"）→ 门禁按副作用拦截。
    expect(capabilityFlags(`totally-unknown-binary-xyz file`)).toEqual({
      readOnly: false,
      sideEffectScope: "system",
    });
  });
});

describe("best-plan gate lets proven read-only bash through", () => {
  const completedResult: ExecutionResult = {
    status: "completed",
    exitCode: 0,
    stdout: { text: "match", bytes: 5, truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    startedAt: new Date(),
    completedAt: new Date(),
  };

  function executorWithBestPlanGate() {
    const sessionId = createSessionId("bash-readonly-gate");
    const turnId = createTurnId("bash-readonly-gate");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const events: SessionEvent[] = [];
    const run = vi.fn<ExecutionPort["run"]>(async () => completedResult);
    const registry = createToolRegistry();
    registry.register(bashToolEntry);
    const executor = createToolExecutor({
      registry,
      permissionService: new PermissionService(),
      permissionBroker: {
        async requestPermission() {
          return { decision: "allow" as const };
        },
      },
      executionPort: { run },
      mode: "build",
      bestPlanGate: true,
      emitEvent: async (event) => {
        events.push(event);
      },
      workingDirectory: "/workspace/never-read",
      sessionId,
      turnId,
      traceContext,
    });
    const execute = (command: string) =>
      executor.execute(
        { id: createToolCallId(command), name: "Bash", input: { command } },
        { traceContext },
      );
    return { run, events, execute, turnId };
  }

  it("executes proven read-only investigation without a best-plan card", async () => {
    const { run, execute } = executorWithBestPlanGate();
    for (const command of FALSE_POSITIVE_COMMANDS) {
      const result = await execute(command);
      expect(result).toMatchObject({ success: true });
    }
    expect(run).toHaveBeenCalledTimes(FALSE_POSITIVE_COMMANDS.length);
  });

  it("still blocks the first real side-effect until a plan is recorded", async () => {
    const { run, events, execute } = executorWithBestPlanGate();
    const blocked = await execute(`rm -rf build`);
    expect(blocked.success).toBe(false);
    expect(blocked.modelContent).toContain("Call ProposeBestPlan first");
    expect(run).not.toHaveBeenCalled();
    expect(
      events.filter((event) => event.type === SessionEventType.ToolCallError).length,
    ).toBeGreaterThanOrEqual(1);
  });
});
