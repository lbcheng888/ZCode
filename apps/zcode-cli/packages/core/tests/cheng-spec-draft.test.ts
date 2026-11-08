import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CHENG_GENERATE_TOOL_NAME,
  ChengGenerateOutputSchema,
  type ChengGenerateOk,
} from "@zcode/contracts";

import {
  builtInTools,
  type ChengGeneratePort,
  type ToolEntry,
  type ToolExecutionContext,
} from "../src/index.js";
import { validateChengSpecDraft } from "../src/tool/handlers/cheng-spec-draft.js";

const JOB_ID = "1f".repeat(32);

function entry(): ToolEntry {
  const found = builtInTools.find(
    (candidate) => candidate.metadata.name === CHENG_GENERATE_TOOL_NAME,
  );
  if (found === undefined) {
    throw new Error(`tool not registered: ${CHENG_GENERATE_TOOL_NAME}`);
  }
  return found;
}

/**
 * 合法最小草案：从 data/spec_v2/tasks/p06_fib.spec.json 派生（含 `ops.fadd` 这类带 fn 限定的
 * 点名模块与其 composes 边），保留夹具的字段名与 link type，只裁掉与校验无关的体量。
 */
function minimalFixtureDraft(): Record<string, unknown> {
  return {
    schema: "csg.spec.v2",
    task: "p06_fib_min",
    requirements: [
      {
        id: "req.p06_fib_min.fib",
        task: "p06_fib_min",
        fn: "fib",
        kind: "behavior",
        text: "fib(n) 返回斐波那契数列第 n 项",
        signature: "fib(n: int32) -> int32",
      },
    ],
    modules: [
      {
        id: "mod.p06_fib_min.fib.fib",
        task: "p06_fib_min",
        name: "fib.fib",
        role: "entry",
        fn: "fib",
      },
      {
        id: "mod.p06_fib_min.ops.fadd",
        task: "p06_fib_min",
        name: "ops.fadd",
        role: "helper",
        fn: "fadd",
      },
    ],
    assertions: [
      {
        id: "ast.p06_fib_min.fib.eval",
        task: "p06_fib_min",
        fn: "fib",
        kind: "eval",
        requirement_ids: ["req.p06_fib_min.fib"],
        module_ids: ["mod.p06_fib_min.fib.fib"],
      },
    ],
    links: [
      {
        id: "lnk.001",
        from: "req.p06_fib_min.fib",
        to: "mod.p06_fib_min.fib.fib",
        type: "implemented_by",
      },
      {
        id: "lnk.002",
        from: "req.p06_fib_min.fib",
        to: "ast.p06_fib_min.fib.eval",
        type: "verified_by",
      },
      {
        id: "lnk.003",
        from: "ast.p06_fib_min.fib.eval",
        to: "mod.p06_fib_min.fib.fib",
        type: "exercises",
      },
      // composes 指向带 fn 限定的点名模块：解析不得按点 naive 切分。
      {
        id: "lnk.004",
        from: "mod.p06_fib_min.fib.fib",
        to: "mod.p06_fib_min.ops.fadd",
        type: "composes",
      },
    ],
  };
}

/** 端口测试替身：记录调用事实，回执形状与生产 host 的摘要三字段一致。 */
function fakeGeneratePort(
  seen: Array<{ specPath: string; task: string; budget?: number }>,
): ChengGeneratePort {
  return {
    async generate(input) {
      seen.push(input);
      return {
        jobId: JOB_ID,
        runId: input.task === "p06_fib_min" ? "run-42" : null,
        state: "succeeded",
      };
    },
  };
}

const workspaces: string[] = [];

function context(overrides: {
  chengGeneratePort?: ChengGeneratePort;
  workspaceRoot?: string;
}): ToolExecutionContext {
  return {
    toolCallId: "call-1",
    workspaceRoot: overrides.workspaceRoot ?? "/tmp/zcode-cheng-spec-test",
    ...(overrides.chengGeneratePort === undefined
      ? {}
      : { chengGeneratePort: overrides.chengGeneratePort }),
  } as unknown as ToolExecutionContext;
}

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cheng-spec-draft-"));
  workspaces.push(dir);
  return dir;
}

afterEach(async () => {
  while (workspaces.length > 0) {
    await rm(workspaces.pop()!, { recursive: true, force: true });
  }
});

describe("validateChengSpecDraft", () => {
  it("accepts a minimal draft derived from the p06_fib fixture", () => {
    const verdict = validateChengSpecDraft(minimalFixtureDraft());
    expect(verdict).toEqual({ ok: true, task: "p06_fib_min" });
  });

  it("accepts a three-layer DAG draft derived from c01_dag3_par", () => {
    const verdict = validateChengSpecDraft({
      ...minimalFixtureDraft(),
      modules: [
        { id: "mod.d.solve", name: "solve" },
        { id: "mod.d.via", name: "via" },
        { id: "mod.d.leaf", name: "leaf" },
      ],
      links: [
        { from: "mod.d.solve", to: "mod.d.via", type: "composes" },
        { from: "mod.d.via", to: "mod.d.leaf", type: "composes" },
      ],
      // 断言 id 不再被引用，但夹具仍要求声明非空。
      assertions: [{ id: "ast.d.solve.eval" }],
    });
    expect(verdict).toEqual({ ok: true, task: "p06_fib_min" });
  });

  it("rejects a non-object draft with a single readable error", () => {
    const verdict = validateChengSpecDraft("not a spec");
    expect(verdict).toEqual({ ok: false, errors: ["spec 草案必须是 JSON 对象，收到 string"] });
  });

  it("rejects a composes cycle and names the exact path", () => {
    const verdict = validateChengSpecDraft({
      ...minimalFixtureDraft(),
      links: [
        { from: "mod.p06_fib_min.fib.fib", to: "mod.p06_fib_min.ops.fadd", type: "composes" },
        { from: "mod.p06_fib_min.ops.fadd", to: "mod.p06_fib_min.fib.fib", type: "composes" },
      ],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // 夹具最小版里 req→mod/ast 的三条 link 被删掉不产生额外错误；环文案要能读出闭环路径。
    expect(verdict.errors).toHaveLength(1);
    expect(verdict.errors[0]).toContain("composes 边构成环");
    expect(verdict.errors[0]).toContain("mod.p06_fib_min.fib.fib → mod.p06_fib_min.ops.fadd");
    expect(verdict.errors[0]).toContain("mod.p06_fib_min.ops.fadd → mod.p06_fib_min.fib.fib");
  });

  it("rejects a composes cycle written with mod.<task>.<name> idiom refs (ids differ from refs)", () => {
    // 回归：composes 边曾存原始 ref，而环检测图按 module id 建键——惯用形互指的环
    // 游离在键集外，拓扑排序看不见，曾整案漏放 {ok:true}。
    const verdict = validateChengSpecDraft({
      task: "t",
      modules: [
        { id: "m1", name: "x" },
        { id: "m2", name: "y" },
      ],
      assertions: [{ id: "asm.ok" }],
      links: [
        { from: "mod.t.x", to: "mod.t.y", type: "composes" },
        { from: "mod.t.y", to: "mod.t.x", type: "composes" },
      ],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // 环路径按归一后的权威 id 呈现。
    expect(verdict.errors).toHaveLength(1);
    expect(verdict.errors[0]).toContain("composes 边构成环: m1 → m2 → m1");
  });

  it("rejects a composes cycle mixing id refs and mod.<task>.<name> idiom refs", () => {
    // 回归：同上根因的混合形——一边 id、一边惯用形，环同样必须被看见。
    const verdict = validateChengSpecDraft({
      task: "t",
      modules: [
        { id: "a1", name: "x" },
        { id: "b1", name: "y" },
      ],
      assertions: [{ id: "asm.ok" }],
      links: [
        { from: "a1", to: "mod.t.y", type: "composes" },
        { from: "b1", to: "a1", type: "composes" },
      ],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.errors).toHaveLength(1);
    expect(verdict.errors[0]).toContain("composes 边构成环: a1 → b1 → a1");
  });

  it("rejects a dangling link endpoint", () => {
    const verdict = validateChengSpecDraft({
      ...minimalFixtureDraft(),
      links: [
        ...minimalFixtureDraft().links,
        {
          id: "lnk.005",
          from: "mod.p06_fib_min.ghost",
          to: "mod.p06_fib_min.ops.fadd",
          type: "composes",
        },
      ],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.errors.some((error) => error.includes("mod.p06_fib_min.ghost"))).toBe(true);
    expect(verdict.errors.join("\n")).toContain("未指向已声明的 requirement/module/assertion");
  });

  it("rejects an empty assertions array", () => {
    const draft = minimalFixtureDraft();
    const verdict = validateChengSpecDraft({ ...draft, assertions: [] });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // 断言清空后，原本指向断言的 link 也一并悬空——两条都要上报，不藏第二条。
    expect(verdict.errors[0]).toBe("assertions 不能为空：没有断言的草案无从验收");
    expect(verdict.errors).toHaveLength(3);
    expect(
      verdict.errors.slice(1).every((error) => error.includes("ast.p06_fib_min.fib.eval")),
    ).toBe(true);
  });

  it("rejects duplicate module names", () => {
    const verdict = validateChengSpecDraft({
      ...minimalFixtureDraft(),
      modules: [
        { id: "mod.a", name: "ops.fadd" },
        { id: "mod.b", name: "ops.fadd" },
      ],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.errors.some((error) => error.includes('重名模块 "ops.fadd"'))).toBe(true);
  });

  it("rejects path-traversal task names", () => {
    for (const task of ["../escape", "a/b", "a\\b", "..", "a..b", "领 空格"]) {
      const verdict = validateChengSpecDraft({ ...minimalFixtureDraft(), task });
      expect(verdict.ok, `task=${task}`).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.errors.some((error) => error.includes("字符不安全"))).toBe(true);
    }
  });

  it("rejects link types outside the fixture enum", () => {
    const verdict = validateChengSpecDraft({
      ...minimalFixtureDraft(),
      links: [
        { from: "mod.p06_fib_min.fib.fib", to: "mod.p06_fib_min.ops.fadd", type: "depends_on" },
      ],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(
      verdict.errors.some(
        (error) => error.includes("depends_on") && error.includes("implemented_by"),
      ),
    ).toBe(true);
  });

  it("accumulates every error in one verdict", () => {
    const verdict = validateChengSpecDraft({ task: "", modules: [], assertions: [] });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts an explicit settle oracle as a no-op", () => {
    const verdict = validateChengSpecDraft({
      ...minimalFixtureDraft(),
      oracle: { kind: "settle" },
    });
    expect(verdict).toEqual({ ok: true, task: "p06_fib_min" });
  });

  it("rejects a property oracle as a declared-but-unwired layer with the fixed leading error", () => {
    const verdict = validateChengSpecDraft({
      ...minimalFixtureDraft(),
      oracle: { kind: "property" },
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    // 固定文案必须原样独占 errors：草案其余部分全绿时，模型看到的就只有这一条引导。
    expect(verdict.errors).toEqual([
      "oracle 层 'property' 已声明未接线（oracle 分层路线 layer-2/3）：当前仅 settle 可执行，请勿提交该层草案",
    ]);
  });

  it("rejects a scenario oracle the same way", () => {
    const verdict = validateChengSpecDraft({
      ...minimalFixtureDraft(),
      oracle: { kind: "scenario" },
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.errors).toEqual([
      "oracle 层 'scenario' 已声明未接线（oracle 分层路线 layer-2/3）：当前仅 settle 可执行，请勿提交该层草案",
    ]);
  });

  it("rejects an oracle kind outside the enum and lists the legal values", () => {
    const verdict = validateChengSpecDraft({
      ...minimalFixtureDraft(),
      oracle: { kind: "fuzz" },
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.errors).toHaveLength(1);
    expect(verdict.errors[0]).toContain('"fuzz"');
    expect(verdict.errors[0]).toContain("settle | property | scenario");
  });

  it("rejects a non-object oracle", () => {
    const verdict = validateChengSpecDraft({
      ...minimalFixtureDraft(),
      oracle: "settle",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.errors).toEqual(["oracle 在场时必须是 JSON 对象，收到 string"]);
  });

  it("rejects an oracle object missing kind", () => {
    // 显式声明 oracle 就必须把 kind 写全：缺省 settle 只对"整个 oracle 字段缺席"生效。
    const verdict = validateChengSpecDraft({
      ...minimalFixtureDraft(),
      oracle: {},
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.errors).toEqual(["oracle.kind 必须是非空字符串"]);
  });

  it("keeps the oracle rejection first while still reporting a composes cycle", () => {
    // 放置契约：oracle 块在形状检查之后、links/composes 之前——不短路，环照报，
    // 固定文案仍是首条。
    const verdict = validateChengSpecDraft({
      ...minimalFixtureDraft(),
      oracle: { kind: "scenario" },
      links: [
        { from: "mod.p06_fib_min.fib.fib", to: "mod.p06_fib_min.ops.fadd", type: "composes" },
        { from: "mod.p06_fib_min.ops.fadd", to: "mod.p06_fib_min.fib.fib", type: "composes" },
      ],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.errors).toHaveLength(2);
    expect(verdict.errors[0]).toContain("oracle 层 'scenario' 已声明未接线");
    expect(verdict.errors[1]).toContain("composes 边构成环");
  });
});

describe("ChengGenerate tool", () => {
  it("returns capability_absent without touching disk when the port is missing", async () => {
    const workspaceRoot = await tempWorkspace();
    const output = await entry().handler(
      { spec: minimalFixtureDraft() },
      context({ workspaceRoot }),
    );
    const parsed = ChengGenerateOutputSchema.parse(output) as
      | ChengGenerateOk
      | { status: "capability_absent" };
    expect(parsed).toMatchObject({ status: "capability_absent" });
    await expect(readdir(workspaceRoot)).resolves.toEqual([]);
  });

  it("returns a 400 failure listing every validation error and starts nothing", async () => {
    const workspaceRoot = await tempWorkspace();
    const seen: Array<{ specPath: string; task: string; budget?: number }> = [];
    const output = await entry().handler(
      { spec: { ...minimalFixtureDraft(), task: "../evil", assertions: [] } },
      context({ workspaceRoot, chengGeneratePort: fakeGeneratePort(seen) }),
    );
    expect(output).toMatchObject({ result: false, errorCode: 400 });
    const failure = output as { result: false; errorCode: number; message: string };
    expect(failure.message).toContain("字符不安全");
    expect(failure.message).toContain("assertions 不能为空");
    expect(seen).toEqual([]);
    await expect(readdir(workspaceRoot)).resolves.toEqual([]);
  });

  it("returns a 400 naming the unwired oracle layer and starts nothing", async () => {
    const workspaceRoot = await tempWorkspace();
    const seen: Array<{ specPath: string; task: string; budget?: number }> = [];
    const output = await entry().handler(
      { spec: { ...minimalFixtureDraft(), oracle: { kind: "property" } } },
      context({ workspaceRoot, chengGeneratePort: fakeGeneratePort(seen) }),
    );
    expect(output).toMatchObject({ result: false, errorCode: 400 });
    const failure = output as { result: false; errorCode: number; message: string };
    expect(failure.message).toContain(
      "oracle 层 'property' 已声明未接线（oracle 分层路线 layer-2/3）：当前仅 settle 可执行，请勿提交该层草案",
    );
    expect(seen).toEqual([]);
    await expect(readdir(workspaceRoot)).resolves.toEqual([]);
  });

  it("persists the draft and returns the job summary", async () => {
    const workspaceRoot = await tempWorkspace();
    const seen: Array<{ specPath: string; task: string; budget?: number }> = [];
    const spec = minimalFixtureDraft();
    const output = await entry().handler(
      { spec, budget: 120_000 },
      context({ workspaceRoot, chengGeneratePort: fakeGeneratePort(seen) }),
    );

    expect(ChengGenerateOutputSchema.parse(output)).toEqual({
      status: "ok",
      jobId: JOB_ID,
      runId: "run-42",
      state: "succeeded",
    });
    expect(seen).toEqual([{ specPath: expect.any(String), task: "p06_fib_min", budget: 120_000 }]);
    const specPath = seen[0].specPath;
    expect(path.isAbsolute(specPath)).toBe(true);
    expect(specPath.startsWith(path.join(workspaceRoot, ".chengcode", "cheng-specs"))).toBe(true);
    expect(path.basename(specPath)).toMatch(/^p06_fib_min-[0-9a-f-]{36}\.json$/);
    expect(JSON.parse(await readFile(specPath, "utf8"))).toEqual(spec);
  });

  it("omits budget from the port call when the caller supplied none", async () => {
    const workspaceRoot = await tempWorkspace();
    const seen: Array<{ specPath: string; task: string; budget?: number }> = [];
    await entry().handler(
      { spec: { ...minimalFixtureDraft(), task: "p06_fib_none" } },
      context({ workspaceRoot, chengGeneratePort: fakeGeneratePort(seen) }),
    );
    expect(seen[0]).toEqual({ specPath: expect.any(String), task: "p06_fib_none" });
    expect("budget" in seen[0]).toBe(false);
  });

  it("oracle 检查先于形状检查：task 非法 + property 并存时固定文案仍占 errors 首条", () => {
    const verdict = validateChengSpecDraft({ task: "../evil", oracle: { kind: "property" } });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.errors[0]).toContain("已声明未接线");
      expect(verdict.errors.some((e) => e.includes("task"))).toBe(true);
    }
  });

  it("oracle:null 的文案点名 null（不再误报 object）", () => {
    const verdict = validateChengSpecDraft({ oracle: null });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.errors[0]).toContain("null");
  });
});
