import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readChengSpecRef } from "../src/adapters/spec-decision.js";
import {
  parseChengSpecRef,
  type ChengSpecRef,
} from "../src/cheng-spec-ref.js";
import { expectContractError, FIXTURES, fixture } from "./helpers.js";

const P02_SPEC_SHA256 =
  "4cb7980f4736b98fe79acd3c1c2a806e14a70fdebb78d7e5dd35826ad71271f3";
const CANON_INDEX_SHA256 =
  "6936717412a74351c21aab8f22692e9cacff5d2d84426ecca725cc1286b3c9ae";
const C01_SPEC_SHA256 =
  "6a210eb3120a6bafec58c3b15a2a99ee8347ddeaa620ee25195c0a88360ab7ab";
const DAG3_INDEX_SHA256 =
  "fc41357545f290e7bbae05bdc75493ba60915a38baec2052173cee353ec2b8ed";

function fixtureText(...parts: string[]): string {
  return fixture("spec-decision", ...parts);
}

function fixturePath(...parts: string[]): string {
  return join(FIXTURES, "spec-decision", ...parts);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where} is not an array`);
  }
  return value;
}

function mutateJson(
  text: string,
  mutate: (value: Record<string, unknown>) => void,
): string {
  const value = asRecord(JSON.parse(text), "document");
  mutate(value);
  return JSON.stringify(value);
}

function moduleAt(
  value: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  return asRecord(asArray(value.modules, "modules")[index], `modules[${index}]`);
}

function linkAt(
  value: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  return asRecord(asArray(value.links, "links")[index], `links[${index}]`);
}

function parseP02(): ChengSpecRef {
  return parseChengSpecRef(
    fixtureText("spec_v2", "tasks", "p02_min2.spec.json"),
    null,
  );
}

describe("ChengSpecRef", () => {
  it("projects the canonical p02 spec with its index entry", () => {
    const ref = parseChengSpecRef(
      fixtureText("spec_v2", "tasks", "p02_min2.spec.json"),
      fixtureText("spec_v2", "index.json"),
    );

    expect(ref).toMatchObject({
      kind: "cheng_spec_ref",
      schema: "cheng.contract.cheng_spec_ref.v1",
      task: "p02_min2",
      taskIndex: 1,
      specPath: "<memory>",
      indexPath: null,
      specSha256: P02_SPEC_SHA256,
      indexSha256: CANON_INDEX_SHA256,
      indexCheck: true,
    });
    expect(ref.modules).toEqual([
      {
        id: "mod.p02_min2.min2",
        name: "min2",
        fnName: "min2",
        role: "entry",
      },
    ]);
    expect(ref.links).toHaveLength(5);
    // implemented_by/verified_by/exercises point at req.*/ast.* ids; only
    // composes endpoints are required to be modules.
    expect(ref.links).toContainEqual({
      id: "lnk.p02_min2.002",
      from: "req.p02_min2.min2",
      to: "ast.p02_min2.min2.eval",
      type: "verified_by",
    });
  });

  it("keeps helper->helper composes edges from the dag3 fixture", () => {
    const ref = parseChengSpecRef(
      fixtureText("spec_v2_dag3", "tasks", "c01_dag3_par.spec.json"),
      fixtureText("spec_v2_dag3", "index.json"),
    );

    expect(ref.task).toBe("c01_dag3_par");
    expect(ref.taskIndex).toBe(201);
    expect(ref.specSha256).toBe(C01_SPEC_SHA256);
    expect(ref.indexSha256).toBe(DAG3_INDEX_SHA256);
    expect(ref.indexCheck).toBe(true);
    expect(ref.modules.map((module) => module.name)).toEqual([
      "inc",
      "dbl",
      "via_inc",
      "via_dbl",
      "solve",
    ]);
    expect(ref.links).toHaveLength(7);

    const composes = ref.links.filter((link) => link.type === "composes");
    expect(composes).toHaveLength(4);
    const moduleIds = new Set(ref.modules.map((module) => module.id));
    for (const link of composes) {
      expect(moduleIds.has(link.from)).toBe(true);
      expect(moduleIds.has(link.to)).toBe(true);
    }
    expect(composes).toContainEqual({
      id: "lnk.c01_dag3_par.006",
      from: "mod.c01_dag3_par.via_inc",
      to: "mod.c01_dag3_par.inc",
      type: "composes",
    });
  });

  it("returns indexCheck=false with null index fields when no index is given", () => {
    const ref = parseP02();
    expect(ref.indexPath).toBeNull();
    expect(ref.indexSha256).toBeNull();
    expect(ref.indexCheck).toBe(false);
    expect(ref.specSha256).toBe(P02_SPEC_SHA256);
  });

  it("keeps indexCheck=true with a null indexPath for text-only index parsing", () => {
    const ref = parseChengSpecRef(
      fixtureText("spec_v2", "tasks", "p02_min2.spec.json"),
      fixtureText("spec_v2", "index.json"),
    );
    expect(ref.indexPath).toBeNull();
    expect(ref.indexCheck).toBe(true);
  });

  it("reads the real files and hashes the raw bytes", () => {
    const specPath = fixturePath("spec_v2", "tasks", "p02_min2.spec.json");
    const indexPath = fixturePath("spec_v2", "index.json");
    const ref = readChengSpecRef(specPath, indexPath);
    expect(ref.specPath).toBe(specPath);
    expect(ref.indexPath).toBe(indexPath);
    expect(ref.specSha256).toBe(P02_SPEC_SHA256);
    expect(ref.indexSha256).toBe(CANON_INDEX_SHA256);
    expect(ref.indexCheck).toBe(true);

    const expected = parseChengSpecRef(
      readFileSync(specPath, "utf8"),
      readFileSync(indexPath, "utf8"),
      specPath,
      { indexPath },
    );
    expect(ref).toEqual(expected);
  });

  it("reads a spec without an index", () => {
    const specPath = fixturePath("spec_v2", "tasks", "p02_min2.spec.json");
    const ref = readChengSpecRef(specPath);
    expect(ref.indexPath).toBeNull();
    expect(ref.indexSha256).toBeNull();
    expect(ref.indexCheck).toBe(false);
  });

  describe("fail-closed", () => {
    const p02 = fixtureText("spec_v2", "tasks", "p02_min2.spec.json");
    const canonIndex = fixtureText("spec_v2", "index.json");
    const dag3 = fixtureText("spec_v2_dag3", "tasks", "c01_dag3_par.spec.json");
    const dag3Index = fixtureText("spec_v2_dag3", "index.json");

    it("rejects a spec whose schema is not csg.spec.v2", () => {
      const text = mutateJson(p02, (value) => {
        value.schema = "csg.spec.v3";
      });
      expectContractError(
        () => parseChengSpecRef(text, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects invalid JSON and non-object specs", () => {
      expectContractError(
        () => parseChengSpecRef("{", null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
      expectContractError(
        () => parseChengSpecRef("[]", null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects duplicate module ids and names", () => {
      // Null index: a mutated spec no longer matches the real index sha, so
      // passing it would fail inside requireIndexShaMatch before superRefine
      // ever checks module uniqueness.
      const duplicateId = mutateJson(dag3, (value) => {
        moduleAt(value, 1).id = moduleAt(value, 0).id;
      });
      const idError = expectContractError(
        () => parseChengSpecRef(duplicateId, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
      expect(idError.detail).toContain(
        "duplicate module id: mod.c01_dag3_par.inc",
      );

      const duplicateName = mutateJson(dag3, (value) => {
        moduleAt(value, 1).name = moduleAt(value, 0).name;
      });
      const nameError = expectContractError(
        () => parseChengSpecRef(duplicateName, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
      expect(nameError.detail).toContain("duplicate module name: inc");
    });

    it("rejects a duplicate link id", () => {
      const text = mutateJson(p02, (value) => {
        linkAt(value, 1).id = linkAt(value, 0).id;
      });
      const error = expectContractError(
        () => parseChengSpecRef(text, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
      expect(error.detail).toContain("duplicate link id: lnk.p02_min2.001");
    });

    it("rejects composes endpoints that are not module ids", () => {
      // Null index for the same reason as above: the mutation changes the
      // spec sha, and this test must reach the composes endpoint check.
      const unknownTo = mutateJson(dag3, (value) => {
        linkAt(value, 3).to = "mod.c01_dag3_par.gone";
      });
      const toError = expectContractError(
        () => parseChengSpecRef(unknownTo, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
      expect(toError.detail).toContain(
        "composes to is not a module id: mod.c01_dag3_par.gone",
      );

      const unknownFrom = mutateJson(dag3, (value) => {
        linkAt(value, 3).from = "req.c01_dag3_par.solve";
      });
      const fromError = expectContractError(
        () => parseChengSpecRef(unknownFrom, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
      expect(fromError.detail).toContain(
        "composes from is not a module id: req.c01_dag3_par.solve",
      );
    });

    it("rejects an unknown link type and an invalid module role", () => {
      const unknownType = mutateJson(p02, (value) => {
        linkAt(value, 0).type = "implements";
      });
      expectContractError(
        () => parseChengSpecRef(unknownType, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const badRole = mutateJson(p02, (value) => {
        moduleAt(value, 0).role = "oracle";
      });
      expectContractError(
        () => parseChengSpecRef(badRole, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects negative and non-integer task_index values", () => {
      const negative = mutateJson(p02, (value) => {
        value.task_index = -1;
      });
      expectContractError(
        () => parseChengSpecRef(negative, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const fractional = mutateJson(p02, (value) => {
        value.task_index = 1.5;
      });
      expectContractError(
        () => parseChengSpecRef(fractional, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects a module without fn and empty modules/links", () => {
      const missingFn = mutateJson(p02, (value) => {
        delete moduleAt(value, 0).fn;
      });
      expectContractError(
        () => parseChengSpecRef(missingFn, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const noModules = mutateJson(p02, (value) => {
        value.modules = [];
      });
      expectContractError(
        () => parseChengSpecRef(noModules, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const noLinks = mutateJson(p02, (value) => {
        value.links = [];
      });
      expectContractError(
        () => parseChengSpecRef(noLinks, null),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects an index that has no entry for the spec task", () => {
      expectContractError(
        () => parseChengSpecRef(p02, dag3Index),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects an index sha that disagrees with the spec sha", () => {
      const text = mutateJson(canonIndex, (value) => {
        const tasks = asArray(value.tasks, "tasks");
        const entry = asRecord(tasks[1], "tasks[1]");
        entry.sha256 = "0".repeat(64);
      });
      expectContractError(
        () => parseChengSpecRef(p02, text),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects index schema drift, missing tasks and malformed entry shas", () => {
      const wrongSchema = mutateJson(canonIndex, (value) => {
        value.schema = "csg.spec.v3.index";
      });
      expectContractError(
        () => parseChengSpecRef(p02, wrongSchema),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const noTasks = mutateJson(canonIndex, (value) => {
        value.tasks = {};
      });
      expectContractError(
        () => parseChengSpecRef(p02, noTasks),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );

      const badEntrySha = mutateJson(canonIndex, (value) => {
        const tasks = asArray(value.tasks, "tasks");
        asRecord(tasks[1], "tasks[1]").sha256 = "zzz";
      });
      expectContractError(
        () => parseChengSpecRef(p02, badEntrySha),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("rejects index fields without index JSON", () => {
      expectContractError(
        () => parseChengSpecRef(p02, null, "<memory>", { indexPath: "/tmp/x" }),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
      expectContractError(
        () =>
          parseChengSpecRef(p02, null, "<memory>", {
            indexSha256: "0".repeat(64),
          }),
        "CHENG_CONTRACT_SCHEMA_INVALID",
      );
    });

    it("fails on missing spec and index files", () => {
      expectContractError(
        () => readChengSpecRef(fixturePath("spec_v2", "tasks", "missing.spec.json")),
        "CHENG_CONTRACT_MISSING_FILE",
      );
      expectContractError(
        () =>
          readChengSpecRef(
            fixturePath("spec_v2", "tasks", "p02_min2.spec.json"),
            fixturePath("spec_v2", "missing.index.json"),
          ),
        "CHENG_CONTRACT_MISSING_FILE",
      );
    });
  });
});
