import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BEST_PLAN_TOOL_NAME,
  CHENG_GENERATE_TOOL_NAME,
  CoreErrorType,
  FileSystemPortError,
  type SessionEvent,
  type TurnId,
} from "@zcode/contracts";
import {
  assertSwarmBashCommandSafe,
  builtInTools,
  createToolExecutor,
  createToolRegistry,
  defaultPermissionConfig,
  DenyPermissionBroker,
  PermissionService,
  TurnEvidenceBuffer,
  WorkspaceWriteLeaseRejectedError,
  type ChengHostToolPort,
  type ToolExecutionContext,
  type ToolHandlerFailure,
} from "../src/index.js";
import { BestPlanInputSchema } from "../src/tool/handlers/best-plan.js";
import {
  CHENG_CHECK_SURFACE_TOOL_NAME,
  CHENG_PROBE_LEAF_TOOL_NAME,
} from "../src/tool/handlers/cheng.js";
import { validateChengSpecDraft } from "../src/tool/handlers/cheng-spec-draft.js";

const JOB_ID = "a".repeat(64);

function validDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task: "clamp_i32",
    modules: [{ id: "mod.clamp_i32.core", name: "core", interface: "fn clamp(x: int32) -> int32" }],
    assertions: [{ id: "ast.clamp_i32.ok" }],
    links: [{ from: "mod.clamp_i32.core", to: "ast.clamp_i32.ok", type: "verified_by" }],
    settleCases: [{ inputs: [5, 0, 10], expected: 5 }],
    evalCases: [{ inputs: [-1, 0, 10], expected: 0 }],
    ...overrides,
  };
}

function getTool(name: string) {
  const entry = builtInTools.find((t) => t.metadata.name === name);
  if (!entry) throw new Error(`Missing built-in tool: ${name}`);
  return entry;
}

describe("Cheng SuperAgent Core (Waves 1-3)", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  describe("Wave 1: cheng-spec-draft & cheng tools", () => {
    it("enforces ^[a-z][a-z0-9_]{0,62}$ on task (rejects hyphens and uppercase)", () => {
      expect(validateChengSpecDraft(validDraft({ task: "bad-hyphen" })).ok).toBe(false);
      expect(validateChengSpecDraft(validDraft({ task: "BadUpper" })).ok).toBe(false);
      expect(validateChengSpecDraft(validDraft({ task: "clamp_i32" })).ok).toBe(true);
    });

    it("rejects non-scalar emission surfaces in modules[].interface and directs to Track II", () => {
      const verdict = validateChengSpecDraft(
        validDraft({
          modules: [
            {
              id: "mod.clamp_i32.core",
              name: "core",
              interface: "fn greet(name: str) -> str",
            },
          ],
        }),
      );
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.errors.some((e) => e.includes("Track II") && e.includes("ChengCheckSurface") && e.includes("ChengProbeLeaf"))).toBe(true);
      }
    });

    it("validates settleCases and evalCases when provided", () => {
      const emptySettle = validateChengSpecDraft(validDraft({ settleCases: [] }));
      expect(emptySettle.ok).toBe(false);
      const badEval = validateChengSpecDraft(validDraft({ evalCases: [{}] }));
      expect(badEval.ok).toBe(false);
    });

    it("uses bundlePrepare when available instead of writing .chengcode/cheng-specs, defaults mode to production, and supports bounded waitMode", async () => {
      const root = makeTempDir("cheng-bundle-");
      const generateSpy = vi.fn(async () => ({
        status: "accepted_running" as const,
        jobId: JOB_ID,
        runId: "run-bounded-1",
        state: "running",
        nextTool: "ChengInspect" as const,
      }));
      const bundlePrepareSpy = vi.fn(async () => ({
        bundleSha256: "b".repeat(64),
        bundleDir: "/tmp/bundles/bbbb",
        specPath: "/tmp/bundles/bbbb/tasks/clamp_i32.spec.json",
        task: "clamp_i32",
        cached: false,
      }));

      const chengHostPort: ChengHostToolPort = {
        inspect: vi.fn() as never,
        verify: vi.fn() as never,
        explain: vi.fn() as never,
        plan: vi.fn() as never,
        bundlePrepare: bundlePrepareSpy,
        generate: generateSpy,
      };

      const res = await getTool(CHENG_GENERATE_TOOL_NAME).handler(
        {
          spec: validDraft(),
          waitMode: "bounded",
          maxWaitMs: 5000,
          moves: "macro",
          useLiblearn: true,
          allowDraftUnowned: true,
        },
        {
          toolCallId: "call-gen-bundle",
          workspaceRoot: root,
          workingDirectory: root,
          chengHostPort,
        } as unknown as ToolExecutionContext,
      );

      expect(bundlePrepareSpy).toHaveBeenCalledTimes(1);
      expect(generateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleDir: "/tmp/bundles/bbbb",
          specPath: "/tmp/bundles/bbbb/tasks/clamp_i32.spec.json",
          task: "clamp_i32",
          mode: "production",
          moves: "macro",
          useLiblearn: true,
          allowDraftUnowned: true,
          waitMode: "bounded",
          maxWaitMs: 5000,
        }),
      );
      expect(res).toEqual({
        status: "accepted_running",
        jobId: JOB_ID,
        runId: "run-bounded-1",
        state: "running",
        nextTool: "ChengInspect",
      });
    });

    it("registers ChengCheckSurface and ChengProbeLeaf as deferred read-only tools and enforces closure root guard", async () => {
      const surfaceTool = getTool(CHENG_CHECK_SURFACE_TOOL_NAME);
      const probeTool = getTool(CHENG_PROBE_LEAF_TOOL_NAME);

      expect(surfaceTool.metadata.shouldDefer).toBe(true);
      expect(surfaceTool.metadata.readOnly).toBe(true);
      expect(probeTool.metadata.shouldDefer).toBe(true);
      expect(probeTool.metadata.readOnly).toBe(true);

      const absentSurface = await surfaceTool.handler(
        { filePath: "src/leaf.cheng" },
        { toolCallId: "call-surf-1", workspaceRoot: "/tmp", workingDirectory: "/tmp" } as unknown as ToolExecutionContext,
      );
      expect(absentSurface).toMatchObject({ status: "capability_absent" });

      const rejectedRoot = (await probeTool.handler(
        { filePath: "kernel/driver/selfhost_main.cheng" },
        { toolCallId: "call-probe-1", workspaceRoot: "/tmp", workingDirectory: "/tmp" } as unknown as ToolExecutionContext,
      )) as ToolHandlerFailure;
      expect(rejectedRoot.result).toBe(false);
      expect(rejectedRoot.errorCode).toBe(400);
    });
  });

  describe("Wave 2: post-write .cheng surface gate & AgentSwarm bash guard", () => {
    it("appends bounded CHENG_SURFACE_VIOLATION notice after Write on a .cheng file", async () => {
      const root = makeTempDir("cheng-surface-write-");
      const targetFile = path.join(root, "foo.cheng");
      const files = new Map<string, string>();

      const registry = createToolRegistry();
      for (const tool of builtInTools) {
        registry.register(tool);
      }

      const checkSurface = vi.fn(async ({ filePath }: { filePath: string }) => ({
        schema: "cheng.contract.surface_report.v1" as const,
        filePath,
        v4Ok: false,
        budgetOk: true,
        lineCount: 20,
        lineCapOk: true,
        violations: [{ ruleId: "ZD01", line: 12, message: "var x: int32 = 0 is forbidden" }],
      }));

      const executor = createToolExecutor({
        registry,
        permissionService: new PermissionService({ ...defaultPermissionConfig, defaultMode: "bypassPermissions" }),
        permissionBroker: { requestPermission: async () => ({ decision: "allow" as const }) },
        emitEvent: async (_event: SessionEvent) => undefined,
        sessionId: "sess-1" as never,
        turnId: "turn-1" as TurnId,
        bestPlanGate: false,
        getWorkingDirectory: () => root,
        getWorkspaceRoot: () => root,
        runtimeScope: "root",
        getMode: () => "bypassPermissions",
        fileSystemPort: {
          stat: async ({ path: p }) => {
            const content = files.get(p);
            if (content === undefined) {
              throw new FileSystemPortError({ code: "not_found", message: "ENOENT" });
            }
            return { exists: true, isFile: true, isDirectory: false, sizeBytes: Buffer.byteLength(content), mtimeMs: 1 };
          },
          readTextFile: async ({ path: p }) => {
            const content = files.get(p);
            if (content === undefined) {
              throw new FileSystemPortError({ code: "not_found", message: "ENOENT" });
            }
            return { content, encoding: "utf8", lineEndings: "LF", revision: { id: "1" } };
          },
          writeTextFile: async ({ path: p, content }) => {
            files.set(p, content);
            return { revision: { id: "2" }, bytesWritten: Buffer.byteLength(content) };
          },
        } as never,
        chengHostPort: {
          inspect: vi.fn() as never,
          verify: vi.fn() as never,
          explain: vi.fn() as never,
          plan: vi.fn() as never,
          generate: vi.fn() as never,
          checkSurface,
        },
      });

      const result = await executor.execute({
        id: "call-write-cheng-1",
        name: "Write",
        input: { file_path: targetFile, content: "var x: int32 = 0\n" },
      });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(checkSurface).toHaveBeenCalledWith({ filePath: targetFile });
      expect(typeof result.modelContent).toBe("string");
      expect(result.modelContent as string).toContain("CHENG_SURFACE_VIOLATION");
      expect(result.modelContent as string).toContain("L12 [ZD01]");
      expect(Buffer.byteLength(result.modelContent as string, "utf8")).toBeLessThan(8192);
    });

    it("blocks compile_admission.sh measure, destructive git commands, and out-of-domain redirects/mutations", () => {
      const root = makeTempDir("swarm-guard-");
      const allowedFile = path.join(root, "allowed.cheng");

      expect(() =>
        assertSwarmBashCommandSafe("bash tools/compile_admission.sh measure", {
          workspaceRoot: root,
          allowedWritePaths: [allowedFile],
        }),
      ).toThrow(WorkspaceWriteLeaseRejectedError);

      expect(() =>
        assertSwarmBashCommandSafe("git checkout -- src/foo.ts", {
          workspaceRoot: root,
          allowedWritePaths: [allowedFile],
        }),
      ).toThrow(WorkspaceWriteLeaseRejectedError);

      expect(() =>
        assertSwarmBashCommandSafe("git reset --hard HEAD", {
          workspaceRoot: root,
          allowedWritePaths: [allowedFile],
        }),
      ).toThrow(WorkspaceWriteLeaseRejectedError);

      expect(() =>
        assertSwarmBashCommandSafe("echo hi > outside.cheng", {
          workspaceRoot: root,
          allowedWritePaths: [allowedFile],
        }),
      ).toThrow(WorkspaceWriteLeaseRejectedError);

      expect(() =>
        assertSwarmBashCommandSafe("rm outside.cheng", {
          workspaceRoot: root,
          allowedWritePaths: [allowedFile],
        }),
      ).toThrow(WorkspaceWriteLeaseRejectedError);

      // Allowed write inside allowedWritePaths & read-only commands pass
      expect(() =>
        assertSwarmBashCommandSafe(`echo ok > ${allowedFile}`, {
          workspaceRoot: root,
          allowedWritePaths: [allowedFile],
        }),
      ).not.toThrow();

      expect(() =>
        assertSwarmBashCommandSafe("git status", {
          workspaceRoot: root,
          allowedWritePaths: [allowedFile],
        }),
      ).not.toThrow();
    });
  });

  describe("Wave 3: TurnEvidenceBuffer & Two-Phase Grounded BestPlan", () => {
    it("enforces maxEntries=16 and maxBytes=12KiB ring buffer limits", () => {
      const buf = new TurnEvidenceBuffer();
      for (let i = 0; i < 25; i++) {
        buf.record({
          toolCallId: `call-${i}`,
          toolName: "Read",
          targetFiles: [`file-${i}.ts`],
          digest: "x".repeat(400),
        });
      }
      expect(buf.length).toBeLessThanOrEqual(16);
      expect(buf.byteLength).toBeLessThanOrEqual(12 * 1024);
      expect(buf.entries()[0]?.toolCallId).toBe("call-9");
      expect(buf.getDigest()).toMatch(/^[0-9a-f]{64}$/);
    });

    it("accepts optional grounding metadata on BestPlanInputSchema", () => {
      const parsed = BestPlanInputSchema.parse({
        summary: "Update clamp_i32",
        currentEvidence: "Read foo.cheng:1-10",
        candidateOptions: [
          { option: "Edit directly", cost: "Low" },
          { option: "Rewrite module", cost: "High" },
        ],
        recommendation: "Edit directly",
        impact: "foo.cheng only",
        verification: "ChengProbeLeaf",
        grounding: {
          phase: "pre_mutation_grounded",
          readToolCallIds: ["call-read-1"],
          chengPlanId: "plan-1",
          chengRunId: "run-1",
          evidenceDigest: "abc123",
        },
      });
      expect(parsed.grounding?.phase).toBe("pre_mutation_grounded");
    });

    it("collects read-only evidence into TurnEvidenceBuffer and lets synthesizeGroundedBestPlan satisfy BestPlan inline without rejection", async () => {
      const root = makeTempDir("grounded-bp-");
      const targetFile = path.join(root, "demo.ts");
      const files = new Map<string, string>([[targetFile, "export const x = 1;\n"]]);

      const registry = createToolRegistry();
      for (const tool of builtInTools) {
        registry.register(tool);
      }

      const evidenceBuffer = new TurnEvidenceBuffer();
      let satisfied = false;
      const synthesizeSpy = vi.fn(async ({ evidence }) => {
        expect(evidence.length).toBe(1);
        expect(evidence[0]?.toolName).toBe("Read");
        satisfied = true;
        return true;
      });

      const executor = createToolExecutor({
        registry,
        permissionService: new PermissionService({ ...defaultPermissionConfig, defaultMode: "bypassPermissions" }),
        permissionBroker: { requestPermission: async () => ({ decision: "allow" as const }) },
        emitEvent: async () => undefined,
        sessionId: "sess-bp" as never,
        turnId: "turn-bp" as TurnId,
        bestPlanGate: true,
        turnEvidenceBuffer: evidenceBuffer,
        getTurnRequestText: () => "Update demo.ts",
        synthesizeGroundedBestPlan: async (input) => {
          const ok = await synthesizeSpy(input);
          return ok;
        },
        getWorkingDirectory: () => root,
        getWorkspaceRoot: () => root,
        runtimeScope: "root",
        getMode: () => "bypassPermissions",
        fileSystemPort: {
          stat: async ({ path: p }) => {
            const content = files.get(p);
            if (content === undefined) {
              const err = new Error("ENOENT") as Error & { code: string };
              err.code = "not_found";
              throw err;
            }
            return { exists: true, isFile: true, isDirectory: false, sizeBytes: Buffer.byteLength(content), mtimeMs: 1 };
          },
          readTextFile: async ({ path: p }) => ({
            content: files.get(p) ?? "",
            encoding: "utf8",
            lineEndings: "LF",
            revision: { id: "1" },
          }),
          readTextFileRange: async ({ path: p }) => {
            const content = files.get(p) ?? "";
            const lines = content.split("\n");
            const sizeBytes = Buffer.byteLength(content);
            return {
              content,
              encoding: "utf8",
              lineEndings: "LF",
              lineCount: lines.length,
              startLine: 1,
              totalLines: lines.length,
              sizeBytes,
              bytesRead: sizeBytes,
              truncated: false,
              revision: { id: "1" },
            };
          },
          writeTextFile: async ({ path: p, content }) => {
            files.set(p, content);
            return { revision: { id: "2" }, bytesWritten: Buffer.byteLength(content) };
          },
        } as never,
      });

      // Override isBestPlanSatisfied via ProposeBestPlan call or check that synthesizeGroundedBestPlan
      // returning true lets the Write proceed directly on first try.
      const readRes = await executor.execute({
        id: "call-read-1",
        name: "Read",
        input: { file_path: targetFile },
      });
      expect(readRes.error).toBeUndefined();
      expect(readRes.success).toBe(true);
      expect(evidenceBuffer.length).toBe(1);

      const writeRes = await executor.execute({
        id: "call-write-1",
        name: "Write",
        input: { file_path: targetFile, content: "export const x = 2;\n" },
      });
      expect(synthesizeSpy).toHaveBeenCalledTimes(1);
      expect(satisfied).toBe(true);
      expect(writeRes.success).toBe(true);
      expect(writeRes.error).toBeUndefined();

      // Without synthesizeGroundedBestPlan, synchronous BestPlan rejection is preserved
      const strictExecutor = createToolExecutor({
        registry,
        permissionService: new PermissionService({ ...defaultPermissionConfig, defaultMode: "bypassPermissions" }),
        permissionBroker: { requestPermission: async () => ({ decision: "allow" as const }) },
        emitEvent: async () => undefined,
        sessionId: "sess-bp-2" as never,
        turnId: "turn-bp-2" as TurnId,
        bestPlanGate: true,
        getWorkingDirectory: () => root,
        getWorkspaceRoot: () => root,
        runtimeScope: "root",
        getMode: () => "bypassPermissions",
      });
      const blockedRes = await strictExecutor.execute({
        id: "call-write-2",
        name: "Write",
        input: { file_path: targetFile, content: "export const x = 3;\n" },
      });
      expect(blockedRes.success).toBe(false);
      expect(blockedRes.error?.type).toBe(CoreErrorType.InvalidStateTransition);
      expect(blockedRes.modelContent).toContain(BEST_PLAN_TOOL_NAME);
    });
  });
});
