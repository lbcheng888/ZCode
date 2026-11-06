import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseSpecComposes,
  readStructureReceipt,
} from "../src/index.js";
import {
  FIXTURES,
  expectContractError,
  fixture,
  mutateTsv,
  rowAt,
  setCell,
} from "./helpers.js";

const DAG3_SPEC = "specs/c01_dag3_par.spec.json";
const P02_SPEC = "specs/p02_min2.spec.json";
const P16_SPEC = "specs/p16_glue_len.spec.json";
const DAG3_MODULES = "dag3/evidence/modules.tsv";

interface MutableSpec {
  schema: string;
  task: string;
  modules: Record<string, unknown>[];
  links: Record<string, unknown>[];
}

function mutateSpec(
  text: string,
  mutate: (spec: MutableSpec) => void,
): string {
  const spec = JSON.parse(text) as MutableSpec;
  mutate(spec);
  return JSON.stringify(spec);
}

function tempModules(content: string): { path: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cheng-structure-"));
  const path = join(dir, "modules.tsv");
  writeFileSync(path, content);
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("StructureReceipt", () => {
  it("reports dag3's 4 composes against 1 ledger call_edge", () => {
    const receipt = readStructureReceipt(
      join(FIXTURES, DAG3_SPEC),
      join(FIXTURES, DAG3_MODULES),
    );
    expect(receipt).toMatchObject({
      kind: "structure_receipt",
      schema: "cheng.contract.structure_receipt.v1",
      task: "c01_dag3_par",
    });
    expect(receipt.specModules).toHaveLength(5);
    expect(receipt.composes).toHaveLength(4);
    expect(receipt.ledger).toHaveLength(5);
    expect(receipt.checks).toMatchObject({
      moduleJoinOk: true,
      composesCallersHaveCallEdges: false,
      specComposesCount: 4,
      ledgerCallEdgesSum: 1,
      coveredComposesCount: 1,
      uncoveredComposesCount: 3,
      structureGateOk: false,
    });
    expect(receipt.violations).toEqual([
      "composes caller solve has call_edges=0 (needs >=2)",
      "composes caller solve has call_edges=0 (needs >=2)",
      "composes caller via_dbl has call_edges=0 (needs >=1)",
    ]);
    expect(receipt.composes.map((edge) => `${edge.callerName}->${edge.calleeName}`)).toEqual([
      "solve->via_inc",
      "solve->via_dbl",
      "via_inc->inc",
      "via_dbl->dbl",
    ]);
  });

  it("passes when every composes caller covers its out-degree", () => {
    const modules = mutateTsv(fixture(DAG3_MODULES), (rows) => {
      setCell(rowAt(rows, 3), 6, "1");
      setCell(rowAt(rows, 4), 6, "1");
      setCell(rowAt(rows, 5), 6, "2");
    });
    const temp = tempModules(modules);
    try {
      const receipt = readStructureReceipt(
        join(FIXTURES, DAG3_SPEC),
        temp.path,
      );
      expect(receipt.checks).toMatchObject({
        moduleJoinOk: true,
        composesCallersHaveCallEdges: true,
        specComposesCount: 4,
        ledgerCallEdgesSum: 4,
        coveredComposesCount: 4,
        uncoveredComposesCount: 0,
        structureGateOk: true,
      });
      expect(receipt.violations).toEqual([]);
    } finally {
      temp.remove();
    }
  });

  it("fails the module join when a spec module is absent from the ledger", () => {
    const modules = mutateTsv(fixture(DAG3_MODULES), (rows) => {
      rows.splice(5, 1);
    });
    const temp = tempModules(modules);
    try {
      const receipt = readStructureReceipt(
        join(FIXTURES, DAG3_SPEC),
        temp.path,
      );
      expect(receipt.checks.moduleJoinOk).toBe(false);
      expect(receipt.checks.structureGateOk).toBe(false);
      expect(receipt.violations).toContain(
        "spec module solve has no modules.tsv row",
      );
    } finally {
      temp.remove();
    }
  });

  it("fails the module join on a role mismatch", () => {
    const modules = mutateTsv(fixture(DAG3_MODULES), (rows) => {
      setCell(rowAt(rows, 5), 3, "helper");
    });
    const temp = tempModules(modules);
    try {
      const receipt = readStructureReceipt(
        join(FIXTURES, DAG3_SPEC),
        temp.path,
      );
      expect(receipt.checks.moduleJoinOk).toBe(false);
      expect(receipt.checks.structureGateOk).toBe(false);
      expect(receipt.violations).toContain(
        "module solve role mismatch: spec=entry ledger=helper",
      );
    } finally {
      temp.remove();
    }
  });

  it("fails closed when a real single-module spec is paired with dag3's ledger", () => {
    const receipt = readStructureReceipt(
      join(FIXTURES, P02_SPEC),
      join(FIXTURES, DAG3_MODULES),
    );
    expect(receipt.specModules).toHaveLength(1);
    expect(receipt.composes).toEqual([]);
    expect(receipt.checks.moduleJoinOk).toBe(false);
    expect(receipt.checks.structureGateOk).toBe(false);
    expect(receipt.violations).toContain(
      "spec module min2 has no modules.tsv row",
    );
  });

  it("fails closed when the modules ledger is missing", () => {
    expectContractError(
      () =>
        readStructureReceipt(
          join(FIXTURES, P16_SPEC),
          join(FIXTURES, "does-not-exist.tsv"),
        ),
      "CHENG_CONTRACT_MISSING_FILE",
    );
  });

  it("rejects a composes endpoint that is not a spec module", () => {
    const text = mutateSpec(fixture(DAG3_SPEC), (spec) => {
      const composes = spec.links.find((link) => link.type === "composes");
      if (composes === undefined) {
        throw new Error("fixture has no composes link");
      }
      composes.to = "mod.c01_dag3_par.missing";
    });
    expectContractError(
      () => parseSpecComposes(text, DAG3_SPEC),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects a duplicate composes edge", () => {
    const text = mutateSpec(fixture(DAG3_SPEC), (spec) => {
      const composes = spec.links.find((link) => link.type === "composes");
      if (composes === undefined) {
        throw new Error("fixture has no composes link");
      }
      spec.links.push({ ...composes, id: "lnk.duplicate" });
    });
    expectContractError(
      () => parseSpecComposes(text, DAG3_SPEC),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects duplicate module ids", () => {
    const text = mutateSpec(fixture(DAG3_SPEC), (spec) => {
      const module = spec.modules[0];
      if (module === undefined) {
        throw new Error("fixture has no modules");
      }
      spec.modules.push({ ...module, name: "inc_dup", fn: "inc_dup" });
    });
    expectContractError(
      () => parseSpecComposes(text, DAG3_SPEC),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects a non-composes spec schema", () => {
    const text = mutateSpec(fixture(P02_SPEC), (spec) => {
      spec.schema = "csg.spec.v1";
    });
    expectContractError(
      () => parseSpecComposes(text, P02_SPEC),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });

  it("rejects invalid JSON", () => {
    expectContractError(
      () => parseSpecComposes("{", DAG3_SPEC),
      "CHENG_CONTRACT_SCHEMA_INVALID",
    );
  });
});
