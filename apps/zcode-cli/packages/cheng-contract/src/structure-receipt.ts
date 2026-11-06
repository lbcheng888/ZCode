import { z } from "zod";

import { ModuleRowSchema, type ModuleRow } from "./module-ledger.js";
import { NonNegativeIntSchema, Sha256Schema, TaskNameSchema } from "./primitives.js";

export const SpecModuleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    fnName: z.string().min(1),
    role: z.enum(["entry", "helper"]),
  })
  .strict();

export type SpecModule = z.infer<typeof SpecModuleSchema>;

export const SpecComposeEdgeSchema = z
  .object({
    linkId: z.string().min(1),
    callerModuleId: z.string().min(1),
    calleeModuleId: z.string().min(1),
    callerName: z.string().min(1),
    calleeName: z.string().min(1),
    callerFnName: z.string().min(1),
    calleeFnName: z.string().min(1),
  })
  .strict();

export type SpecComposeEdge = z.infer<typeof SpecComposeEdgeSchema>;

/**
 * The composes projection of a `csg.spec.v2` task.
 *
 * Depends on the spec's `modules[].{id,name,fn,role}` and
 * `links[type=composes].{from,to}`. Both entry→helper and helper→helper
 * composes are allowed; dag3 proves helper→helper exists.
 */
export const SpecComposesSchema = z
  .object({
    kind: z.literal("spec_composes"),
    schema: z.literal("cheng.contract.spec_composes.v1"),
    task: TaskNameSchema,
    specPath: z.string().min(1),
    specSha256: Sha256Schema,
    modules: z.array(SpecModuleSchema).min(1),
    composes: z.array(SpecComposeEdgeSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    const ids = new Set<string>();
    const names = new Set<string>();
    value.modules.forEach((module, index) => {
      if (ids.has(module.id)) {
        issue(`duplicate module id: ${module.id}`, ["modules", index, "id"]);
      }
      ids.add(module.id);
      if (names.has(module.name)) {
        issue(`duplicate module name: ${module.name}`, ["modules", index, "name"]);
      }
      names.add(module.name);
    });

    const moduleById = new Map(value.modules.map((module) => [module.id, module]));
    const linkIds = new Set<string>();
    const pairs = new Set<string>();
    value.composes.forEach((edge, index) => {
      if (linkIds.has(edge.linkId)) {
        issue(`duplicate composes link id: ${edge.linkId}`, [
          "composes",
          index,
          "linkId",
        ]);
      }
      linkIds.add(edge.linkId);
      const caller = moduleById.get(edge.callerModuleId);
      const callee = moduleById.get(edge.calleeModuleId);
      if (caller === undefined) {
        issue(`composes caller module not found: ${edge.callerModuleId}`, [
          "composes",
          index,
          "callerModuleId",
        ]);
      }
      if (callee === undefined) {
        issue(`composes callee module not found: ${edge.calleeModuleId}`, [
          "composes",
          index,
          "calleeModuleId",
        ]);
      }
      if (caller !== undefined) {
        if (caller.name !== edge.callerName || caller.fnName !== edge.callerFnName) {
          issue("composes caller name/fn does not match its module", [
            "composes",
            index,
            "callerName",
          ]);
        }
      }
      if (callee !== undefined) {
        if (callee.name !== edge.calleeName || callee.fnName !== edge.calleeFnName) {
          issue("composes callee name/fn does not match its module", [
            "composes",
            index,
            "calleeName",
          ]);
        }
      }
      const pair = `${edge.callerModuleId}->${edge.calleeModuleId}`;
      if (pairs.has(pair)) {
        issue(`duplicate composes edge: ${pair}`, ["composes", index]);
      }
      pairs.add(pair);
    });
  });

export type SpecComposes = z.infer<typeof SpecComposesSchema>;

export const StructureChecksSchema = z
  .object({
    moduleJoinOk: z.boolean(),
    composesCallersHaveCallEdges: z.boolean(),
    specComposesCount: NonNegativeIntSchema,
    ledgerCallEdgesSum: NonNegativeIntSchema,
    coveredComposesCount: NonNegativeIntSchema,
    uncoveredComposesCount: NonNegativeIntSchema,
    structureGateOk: z.boolean(),
  })
  .strict();

export type StructureChecks = z.infer<typeof StructureChecksSchema>;

interface StructureCheckInput {
  specModules: SpecModule[];
  composes: SpecComposeEdge[];
  ledger: ModuleRow[];
}

interface StructureCheckResult {
  checks: StructureChecks;
  violations: string[];
}

/**
 * Combine spec composes edges with modules.tsv call-edge counts.
 *
 * modules.tsv exposes only per-module counts, not `(caller,callee)` pair
 * identity. Therefore this gate is count-based: every composes caller must have
 * `call_edges >= ` its composes out-degree. Pair identity remains a trace-level
 * check; the receipt records both the spec edge count and the ledger sum so the
 * gap is visible.
 */
export function computeStructureChecks(
  value: StructureCheckInput,
): StructureCheckResult {
  const violations: string[] = [];
  const ledgerByName = new Map(value.ledger.map((row) => [row.name, row]));
  const specByName = new Map(value.specModules.map((module) => [module.name, module]));

  let moduleJoinOk = true;
  for (const module of value.specModules) {
    const row = ledgerByName.get(module.name);
    if (row === undefined) {
      moduleJoinOk = false;
      violations.push(`spec module ${module.name} has no modules.tsv row`);
    } else if (row.role !== module.role) {
      moduleJoinOk = false;
      violations.push(
        `module ${module.name} role mismatch: spec=${module.role} ledger=${row.role}`,
      );
    }
  }
  for (const row of value.ledger) {
    const module = specByName.get(row.name);
    if (module === undefined) {
      moduleJoinOk = false;
      violations.push(`modules.tsv row ${row.name} has no spec module`);
    } else if (module.role !== row.role) {
      moduleJoinOk = false;
      violations.push(
        `module ${row.name} role mismatch: spec=${module.role} ledger=${row.role}`,
      );
    }
  }

  let coveredComposesCount = 0;
  const outDegree = new Map<string, number>();
  for (const edge of value.composes) {
    outDegree.set(edge.callerName, (outDegree.get(edge.callerName) ?? 0) + 1);
  }
  for (const edge of value.composes) {
    const caller = ledgerByName.get(edge.callerName);
    const needed = outDegree.get(edge.callerName) ?? 1;
    if (caller === undefined) {
      violations.push(`composes caller ${edge.callerName} has no modules.tsv row`);
      continue;
    }
    if (caller.callEdges >= needed) {
      coveredComposesCount += 1;
    } else {
      violations.push(
        `composes caller ${edge.callerName} has call_edges=${caller.callEdges} (needs >=${needed})`,
      );
    }
  }

  const specComposesCount = value.composes.length;
  const uncoveredComposesCount = specComposesCount - coveredComposesCount;
  const composesCallersHaveCallEdges = uncoveredComposesCount === 0;
  const ledgerCallEdgesSum = value.ledger.reduce(
    (sum, row) => sum + row.callEdges,
    0,
  );
  const structureGateOk = moduleJoinOk && composesCallersHaveCallEdges;

  return {
    checks: {
      moduleJoinOk,
      composesCallersHaveCallEdges,
      specComposesCount,
      ledgerCallEdgesSum,
      coveredComposesCount,
      uncoveredComposesCount,
      structureGateOk,
    },
    violations,
  };
}

/**
 * Typed structure receipt: spec composes edges + modules.tsv call-edge counts.
 * A false `structureGateOk` is a valid receipt (the violation is the finding);
 * the schema rejects a receipt whose checks do not match its own artifacts.
 */
export const StructureReceiptSchema = z
  .object({
    kind: z.literal("structure_receipt"),
    schema: z.literal("cheng.contract.structure_receipt.v1"),
    task: TaskNameSchema,
    specPath: z.string().min(1),
    specSha256: Sha256Schema,
    modulesPath: z.string().min(1),
    modulesSha256: Sha256Schema,
    specModules: z.array(SpecModuleSchema).min(1),
    composes: z.array(SpecComposeEdgeSchema),
    ledger: z.array(ModuleRowSchema).min(1),
    checks: StructureChecksSchema,
    violations: z.array(z.string()),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    const computed = computeStructureChecks(value);
    for (const field of [
      "moduleJoinOk",
      "composesCallersHaveCallEdges",
      "specComposesCount",
      "ledgerCallEdgesSum",
      "coveredComposesCount",
      "uncoveredComposesCount",
      "structureGateOk",
    ] as const) {
      if (value.checks[field] !== computed.checks[field]) {
        issue(`checks.${field} does not match the artifact-derived value`, [
          "checks",
          field,
        ]);
      }
    }
    if (
      value.violations.length !== computed.violations.length ||
      value.violations.some((violation, index) => violation !== computed.violations[index])
    ) {
      issue("violations do not match the artifact-derived violations", [
        "violations",
      ]);
    }
  });

export type StructureReceipt = z.infer<typeof StructureReceiptSchema>;

export function buildStructureReceipt(
  spec: SpecComposes,
  ledger: {
    sourcePath: string;
    sourceSha256: string;
    modules: ModuleRow[];
  },
): StructureReceipt {
  const computed = computeStructureChecks({
    specModules: spec.modules,
    composes: spec.composes,
    ledger: ledger.modules,
  });
  return StructureReceiptSchema.parse({
    kind: "structure_receipt",
    schema: "cheng.contract.structure_receipt.v1",
    task: spec.task,
    specPath: spec.specPath,
    specSha256: spec.specSha256,
    modulesPath: ledger.sourcePath,
    modulesSha256: ledger.sourceSha256,
    specModules: spec.modules,
    composes: spec.composes,
    ledger: ledger.modules,
    checks: computed.checks,
    violations: computed.violations,
  });
}
