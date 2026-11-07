import { describe, expect, it } from "vitest";

import {
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  WORLD_RUN_DENIED_CODE,
} from "../src/index.js";

describe("world.run Cheng runner denylist", () => {
  it("rejects a shell invocation of the generation script", () => {
    const workflow = createWorkflowProgram(
      `const r = await world.run("bash", ["tools/csg_generate.sh", "--spec", "x"]);\nreturn r.exitCode;`,
    );
    const result = collectWorldRunCommands(workflow, collectSites(workflow));
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: WORLD_RUN_DENIED_CODE });
    expect(result.diagnostics[0]?.message).toContain("csg_generate.sh");
    expect(result.diagnostics[0]?.message).toContain("cheng.generate");
    expect(result.commands).toEqual(["bash"]);
  });

  it("rejects the runner as the command or via another runner name", () => {
    for (const script of [
      `await world.run("tools/csg_spec_v2_cli_run", ["--out:x"]);`,
      `await world.run("sh", ["/repo/tools/cheng_decide.sh"]);`,
      `await world.run("bash", ["tools/csg_ast_m5_run.sh"]);`,
    ]) {
      const workflow = createWorkflowProgram(script);
      const result = collectWorldRunCommands(workflow, collectSites(workflow));
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        WORLD_RUN_DENIED_CODE,
      ]);
    }
  });

  it("keeps ordinary world.run commands and unrelated scripts allowed", () => {
    const workflow = createWorkflowProgram(
      `await world.run("pnpm", ["test"]);\nawait world.run("bash", ["tools/other.sh"]);\nreturn 0;`,
    );
    const result = collectWorldRunCommands(workflow, collectSites(workflow));
    expect(result.diagnostics).toEqual([]);
    expect(result.commands).toEqual(["bash", "pnpm"]);
  });
});
