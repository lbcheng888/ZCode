import { describe, expect, it, vi } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type FileSystemPort,
} from "@zcode/contracts";

import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { applyPatchHandler } from "../src/tool/handlers/apply-patch.js";
import { bashHandler } from "../src/tool/handlers/bash.js";
import { editHandler } from "../src/tool/handlers/edit.js";
import { writeHandler } from "../src/tool/handlers/write.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolExecutionContext, WorkspaceWriteLeaseAdmissionPort } from "../src/tool/types.js";

function admissionPort(
  assertWriteAllowed: WorkspaceWriteLeaseAdmissionPort["assertWriteAllowed"],
): WorkspaceWriteLeaseAdmissionPort {
  return { assertWriteAllowed };
}

function context(
  port: WorkspaceWriteLeaseAdmissionPort,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    toolCallId: "tool_lease_admission",
    traceId: "trace_lease_admission",
    abortSignal: new AbortController().signal,
    workspaceRoot: "/workspace",
    workingDirectory: "/workspace",
    workspaceWriteLeaseAdmission: port,
    ...overrides,
  };
}

describe("workspace write lease admission at tool entry", () => {
  it("rejects Write before touching FileSystemPort when the admission port throws", async () => {
    const assertWriteAllowed = vi.fn(() => {
      throw new Error("second writer rejected");
    });
    await expect(
      writeHandler(
        { file_path: "/workspace/a.txt", content: "nope" },
        context(admissionPort(assertWriteAllowed)),
      ),
    ).rejects.toThrow("second writer rejected");
    expect(assertWriteAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Write", paths: ["/workspace/a.txt"] }),
    );
  });

  it("rejects Edit at the same entry", async () => {
    const assertWriteAllowed = vi.fn(() => {
      throw new Error("second writer rejected");
    });
    await expect(
      editHandler(
        { file_path: "/workspace/b.txt", old_string: "a", new_string: "b" },
        context(admissionPort(assertWriteAllowed)),
      ),
    ).rejects.toThrow("second writer rejected");
    expect(assertWriteAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Edit", paths: ["/workspace/b.txt"] }),
    );
  });

  it("rejects ApplyPatch with the parsed target paths", async () => {
    const assertWriteAllowed = vi.fn(() => {
      throw new Error("second writer rejected");
    });
    const fs = { writeTextFile: vi.fn() } as unknown as FileSystemPort;
    const patch = "*** Begin Patch\n*** Add File: c.txt\n+hello\n*** End Patch";
    const ctx = { ...context(admissionPort(assertWriteAllowed)), fileSystemPort: fs };
    await expect(applyPatchHandler({ patch_text: patch }, ctx)).rejects.toThrow(
      "second writer rejected",
    );
    expect(assertWriteAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "ApplyPatch", paths: ["c.txt"] }),
    );
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });

  it("rejects non-read-only Bash before spawn", async () => {
    const assertWriteAllowed = vi.fn(() => {
      throw new Error("second writer rejected");
    });
    const run = vi.fn(async () => {
      throw new Error("execution must not run");
    });
    const ctx = context(admissionPort(assertWriteAllowed), {
      executionPort: { run } as never,
    });
    await expect(bashHandler({ command: "echo hi > out.txt" }, ctx)).rejects.toThrow(
      "second writer rejected",
    );
    expect(assertWriteAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Bash", paths: [] }),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects Bash whose command shape is a write (uniq output operand) before spawn", async () => {
    // 分类器边界：uniq 的第二个位置参数是输出文件——曾被 allowAnyArgs 误判只读而
    // 绕过写租约；收紧后该形状在 spawn 前与 Write/Edit 同闸拒第二写者。
    const assertWriteAllowed = vi.fn(() => {
      throw new Error("second writer rejected");
    });
    const run = vi.fn(async () => {
      throw new Error("execution must not run");
    });
    const ctx = context(admissionPort(assertWriteAllowed), {
      executionPort: { run } as never,
    });
    await expect(bashHandler({ command: "uniq in.txt out.txt" }, ctx)).rejects.toThrow(
      "second writer rejected",
    );
    expect(assertWriteAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Bash", paths: [] }),
    );
    expect(run).not.toHaveBeenCalled();

    // 对照：单输入 uniq 仍是只读，不过闸、不误伤。
    const readOnlyRun = vi.fn(async () => {
      throw new Error("execution reached");
    });
    await expect(
      bashHandler(
        { command: "uniq -f 1 in.txt" },
        context(
          admissionPort(
            vi.fn(() => {
              throw new Error("must not admit read-only uniq");
            }),
          ),
          { executionPort: { run: readOnlyRun } as never },
        ),
      ),
    ).rejects.toThrow("execution reached");
    expect(readOnlyRun).toHaveBeenCalledTimes(1);
  });

  it("allows read-only Bash through the same context", async () => {
    const assertWriteAllowed = vi.fn(() => {
      throw new Error("second writer rejected");
    });
    const run = vi.fn(async () => {
      throw new Error("execution reached");
    });
    await expect(
      bashHandler(
        { command: "ls" },
        context(admissionPort(assertWriteAllowed), {
          executionPort: { run } as never,
        }),
      ),
    ).rejects.toThrow("execution reached");
    expect(assertWriteAllowed).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("passes the spec-run owner id to Bash admission", async () => {
    const assertWriteAllowed = vi.fn();
    const run = vi.fn(async () => {
      throw new Error("execution reached");
    });
    await expect(
      bashHandler(
        { command: "npm test" },
        context(admissionPort(assertWriteAllowed), {
          executionPort: { run } as never,
          writeLeaseOwnerRunId: "run-spec-1",
        }),
      ),
    ).rejects.toThrow("execution reached");
    expect(assertWriteAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Bash", ownerRunId: "run-spec-1" }),
    );
  });

  it("propagates the port and spec-run owner id into ToolExecutionContext", async () => {
    const sessionId = createSessionId("lease-admission-context");
    const turnId = createTurnId("lease-admission-context");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    const assertWriteAllowed = vi.fn();
    let observed: ToolExecutionContext | undefined;
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "LeaseProbe",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
        patternSources: ["none"],
        denyPriority: "beforeAsk",
      },
      handler: async (_input, toolContext) => {
        observed = toolContext;
        return "ok";
      },
    } as never);

    const executor = createToolExecutor({
      emitEvent: async () => {},
      workspaceWriteLeaseAdmission: admissionPort(assertWriteAllowed),
      getWriteLeaseOwnerRunId: () => "run-spec-1",
      mode: "yolo",
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      traceContext,
      turnId,
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });
    await executor.execute(
      { id: createToolCallId("lease-probe"), input: {}, name: "LeaseProbe" },
      { traceContext },
    );

    expect(observed?.workspaceWriteLeaseAdmission).toBeDefined();
    expect(observed?.writeLeaseOwnerRunId).toBe("run-spec-1");
    expect(observed?.workspaceRoot).toBe("/workspace");
  });
});
