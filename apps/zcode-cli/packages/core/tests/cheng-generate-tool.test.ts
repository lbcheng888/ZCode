import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CHENG_GENERATE_TOOL_NAME, ChengGenerateOutputSchema } from "@zcode/contracts";

import {
  CHENG_READ_PORT_UNAVAILABLE_REASON,
  builtInTools,
  type ChengGeneratePort,
  type ToolEntry,
  type ToolExecutionContext,
  type ToolHandlerFailure,
} from "../src/index.js";

const JOB_ID = "c".repeat(64);

function entry(): ToolEntry {
  const found = builtInTools.find(
    (candidate) => candidate.metadata.name === CHENG_GENERATE_TOOL_NAME,
  );
  if (found === undefined) {
    throw new Error(`tool not registered: ${CHENG_GENERATE_TOOL_NAME}`);
  }
  return found;
}

function context(input: { port?: ChengGeneratePort; workspaceRoot: string }): ToolExecutionContext {
  return {
    toolCallId: "call-gen-1",
    workspaceRoot: input.workspaceRoot,
    workingDirectory: input.workspaceRoot,
    ...(input.port === undefined ? {} : { chengGeneratePort: input.port }),
  } as unknown as ToolExecutionContext;
}

/** 能过校验器的最小合法草案：声明两侧齐全、link 端点可解析、composes 无环。 */
const VALID_SPEC = {
  task: "p01_max2",
  requirements: [{ id: "req.max" }, { id: "req.second" }],
  modules: [
    { id: "mod.p01_max2.core", name: "core" },
    { id: "mod.p01_max2.ops", name: "ops" },
  ],
  assertions: [{ id: "asm.max_ok" }, { id: "asm.second_ok" }],
  links: [
    { from: "req.max", to: "mod.p01_max2.core", type: "implemented_by" },
    { from: "mod.p01_max2.core", to: "asm.max_ok", type: "verified_by" },
    { from: "mod.p01_max2.core", to: "mod.p01_max2.ops", type: "composes" },
  ],
};

/** 对象形状合法、内容全坏：一次性收齐全部错误，而不是挤牙膏。 */
const INVALID_SPEC = {
  task: "bad task/name",
  modules: [],
  assertions: [],
  links: [{ from: "ghost", to: "nowhere", type: "bogus_link" }],
};

describe("ChengGenerate", () => {
  const roots: string[] = [];

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "cheng-generate-"));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop() as string, { recursive: true, force: true });
    }
  });

  it("persists a valid draft under <workspaceRoot>/.chengcode/cheng-specs/ and hands the port the absolute specPath, task and budget", async () => {
    const root = makeRoot();
    const calls: {
      specPath: string;
      task: string;
      budget?: number;
    }[] = [];
    const port: ChengGeneratePort = {
      async generate(input) {
        calls.push(input);
        return { jobId: JOB_ID, runId: "run-7", state: "succeeded" };
      },
    };

    const output = await entry().handler(
      { spec: VALID_SPEC, budget: 5000 },
      context({ port, workspaceRoot: root }),
    );

    expect(ChengGenerateOutputSchema.parse(output)).toMatchObject({
      status: "ok",
      jobId: JOB_ID,
      runId: "run-7",
      state: "succeeded",
    });

    // 落盘：workspaceRoot 下的 .chengcode/cheng-specs/<task>-<uuid>.json
    const specsDir = join(root, ".chengcode", "cheng-specs");
    const files = readdirSync(specsDir);
    expect(files).toHaveLength(1);
    expect(files[0].startsWith("p01_max2-")).toBe(true);
    expect(files[0].endsWith(".json")).toBe(true);

    // 端口收到的是宿主可直接读的绝对路径 + 校验器裁决出的 task + 显式 budget
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toBe("p01_max2");
    expect(calls[0].budget).toBe(5000);
    expect(calls[0].specPath).toBe(join(specsDir, files[0]));
    expect(calls[0].specPath.startsWith(root)).toBe(true);

    // 文件内容就是草案本身（宿主按 specPath 读到的与模型提交的同字节语义）
    expect(JSON.parse(readFileSync(calls[0].specPath, "utf8"))).toEqual(VALID_SPEC);
  });

  it("rejects an invalid draft with a typed 400 listing every error, writing no file and calling no host", async () => {
    const root = makeRoot();
    let portCalls = 0;
    const port: ChengGeneratePort = {
      async generate() {
        portCalls += 1;
        return { jobId: JOB_ID, runId: null, state: "failed" };
      },
    };

    const output = await entry().handler(
      { spec: INVALID_SPEC },
      context({ port, workspaceRoot: root }),
    );

    const failure = output as ToolHandlerFailure;
    expect(failure.result).toBe(false);
    expect(failure.errorCode).toBe(400);
    // 全部错误一次性上浮：task 字符、空 modules、空 assertions、坏 link 各就各位
    expect(failure.message).toContain("task 名");
    expect(failure.message).toContain("modules 不能为空");
    expect(failure.message).toContain("assertions 不能为空");
    expect(failure.message).toContain("bogus_link");
    expect(failure.message).toContain("ghost");

    expect(existsSync(join(root, ".chengcode"))).toBe(false);
    expect(portCalls).toBe(0);
  });

  it("returns capability_absent when the generate port is not wired", async () => {
    const output = await entry().handler(
      { spec: VALID_SPEC },
      context({ workspaceRoot: makeRoot() }),
    );
    expect(output).toMatchObject({
      status: "capability_absent",
      reason: CHENG_READ_PORT_UNAVAILABLE_REASON,
    });
  });

  it("budget 越界（>900_000）在落盘前被 schema 拒绝，不留孤儿 spec 文件", async () => {
    const port: { generate: (input: unknown) => Promise<unknown> } = {
      generate: () => {
        throw new Error("generate must not be called");
      },
    };
    // schema 在入口即抛 ZodError：拒绝发生在任何落盘副作用之前。
    await expect(
      entry().handler(
        { spec: VALID_SPEC, budget: 900_001 },
        context({ workspaceRoot: makeRoot(), chengGeneratePort: port as never }),
      ),
    ).rejects.toThrow(/900000/);
    expect(existsSync(join(makeRoot(), ".chengcode", "cheng-specs"))).toBe(false);
  });
});
