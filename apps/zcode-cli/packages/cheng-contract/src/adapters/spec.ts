import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ChengContractError } from "../errors.js";
import {
  SpecComposesSchema,
  buildStructureReceipt,
  type SpecComposeEdge,
  type SpecComposes,
  type SpecModule,
  type StructureReceipt,
} from "../structure-receipt.js";
import { readModuleLedger } from "./run-volume.js";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readSpecFile(specPath: string): { text: string; sha256: string } {
  const path = resolve(specPath);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ChengContractError({
        code: "CHENG_CONTRACT_MISSING_FILE",
        sourcePath: path,
        detail: "file not found",
        cause: error,
      });
    }
    throw new ChengContractError({
      code: "CHENG_CONTRACT_IO_ERROR",
      sourcePath: path,
      detail: `cannot read file: ${(error as Error).message}`,
      cause: error,
    });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ChengContractError({
      code: "CHENG_CONTRACT_SCHEMA_INVALID",
      sourcePath: path,
      detail: "file is not valid UTF-8",
      cause: error,
    });
  }
  return { text, sha256: sha256Hex(bytes) };
}

function invalid(sourcePath: string, detail: string): ChengContractError {
  return new ChengContractError({
    code: "CHENG_CONTRACT_SCHEMA_INVALID",
    sourcePath,
    line: null,
    detail,
  });
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  sourcePath: string,
  where: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw invalid(sourcePath, `${where}.${key} must be a non-empty string`);
  }
  return field;
}

/**
 * Project a `csg.spec.v2` JSON task into its modules and composes edges.
 * Only `links[type=composes]` are consumed; missing endpoints fail closed.
 */
export function parseSpecComposes(
  jsonText: string,
  sourcePath = "<memory>",
  sourceSha256 = sha256Hex(Buffer.from(jsonText, "utf8")),
): SpecComposes {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw invalid(sourcePath, `invalid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalid(sourcePath, "spec must be a JSON object");
  }
  const spec = parsed as Record<string, unknown>;
  if (spec.schema !== "csg.spec.v2") {
    throw invalid(sourcePath, `schema must be csg.spec.v2, got ${JSON.stringify(spec.schema)}`);
  }
  const task = requireString(spec, "task", sourcePath, "spec");
  if (!Array.isArray(spec.modules)) {
    throw invalid(sourcePath, "spec.modules must be an array");
  }
  if (!Array.isArray(spec.links)) {
    throw invalid(sourcePath, "spec.links must be an array");
  }

  const modules: SpecModule[] = spec.modules.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalid(sourcePath, `modules[${index}] must be an object`);
    }
    const value = raw as Record<string, unknown>;
    const role = requireString(value, "role", sourcePath, `modules[${index}]`);
    if (role !== "entry" && role !== "helper") {
      throw invalid(sourcePath, `modules[${index}].role must be entry or helper`);
    }
    return {
      id: requireString(value, "id", sourcePath, `modules[${index}]`),
      name: requireString(value, "name", sourcePath, `modules[${index}]`),
      fnName: requireString(value, "fn", sourcePath, `modules[${index}]`),
      role,
    };
  });

  const moduleById = new Map(modules.map((module) => [module.id, module]));
  const composes: SpecComposeEdge[] = [];
  spec.links.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalid(sourcePath, `links[${index}] must be an object`);
    }
    const value = raw as Record<string, unknown>;
    if (value.type !== "composes") {
      return;
    }
    const linkId = requireString(value, "id", sourcePath, `links[${index}]`);
    const from = requireString(value, "from", sourcePath, `links[${index}]`);
    const to = requireString(value, "to", sourcePath, `links[${index}]`);
    const caller = moduleById.get(from);
    const callee = moduleById.get(to);
    if (caller === undefined) {
      throw invalid(sourcePath, `links[${index}] composes caller module not found: ${from}`);
    }
    if (callee === undefined) {
      throw invalid(sourcePath, `links[${index}] composes callee module not found: ${to}`);
    }
    composes.push({
      linkId,
      callerModuleId: caller.id,
      calleeModuleId: callee.id,
      callerName: caller.name,
      calleeName: callee.name,
      callerFnName: caller.fnName,
      calleeFnName: callee.fnName,
    });
  });

  const result = SpecComposesSchema.safeParse({
    kind: "spec_composes",
    schema: "cheng.contract.spec_composes.v1",
    task,
    specPath: sourcePath,
    specSha256: sourceSha256,
    modules,
    composes,
  });
  if (!result.success) {
    throw invalid(
      sourcePath,
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    );
  }
  return result.data;
}

export function readSpecComposes(specPath: string): SpecComposes {
  const file = readSpecFile(specPath);
  return parseSpecComposes(file.text, resolve(specPath), file.sha256);
}

/**
 * Read a spec and its modules.tsv ledger, then build the structure receipt.
 * A false `structureGateOk` is returned as a receipt, not thrown; missing
 * files and malformed inputs throw a typed ChengContractError.
 */
export function readStructureReceipt(
  specPath: string,
  modulesPath: string,
): StructureReceipt {
  const spec = readSpecComposes(specPath);
  const ledger = readModuleLedger(modulesPath);
  return buildStructureReceipt(spec, ledger);
}
