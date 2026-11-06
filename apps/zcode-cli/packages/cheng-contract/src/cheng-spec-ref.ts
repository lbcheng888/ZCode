import { createHash } from "node:crypto";

import { z } from "zod";

import { ChengContractError } from "./errors.js";
import {
  ModuleRoleSchema,
  NonNegativeIntSchema,
  Sha256Schema,
  TaskNameSchema,
} from "./primitives.js";

export const SpecLinkTypeSchema = z.enum([
  "implemented_by",
  "verified_by",
  "exercises",
  "composes",
]);

export type SpecLinkType = z.infer<typeof SpecLinkTypeSchema>;

export const ChengSpecRefModuleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    fnName: z.string().min(1),
    role: ModuleRoleSchema,
  })
  .strict();

export type ChengSpecRefModule = z.infer<typeof ChengSpecRefModuleSchema>;

export const ChengSpecRefLinkSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    type: SpecLinkTypeSchema,
  })
  .strict();

export type ChengSpecRefLink = z.infer<typeof ChengSpecRefLinkSchema>;

/**
 * Typed projection of a `csg.spec.v2` task plus its optional index entry.
 *
 * The projection keeps every link, not only `composes`: `implemented_by`,
 * `verified_by` and `exercises` legitimately point at `req.*`/`ast.*` ids, so
 * module-endpoint checks apply only to `composes`. `indexCheck=false` means no
 * index was supplied; a supplied index that is missing the task entry or whose
 * `sha256` disagrees with the spec is rejected in `parseChengSpecRef`.
 */
export const ChengSpecRefSchema = z
  .object({
    kind: z.literal("cheng_spec_ref"),
    schema: z.literal("cheng.contract.cheng_spec_ref.v1"),
    task: TaskNameSchema,
    taskIndex: NonNegativeIntSchema,
    specPath: z.string().min(1),
    specSha256: Sha256Schema,
    indexPath: z.string().min(1).nullable(),
    indexSha256: Sha256Schema.nullable(),
    modules: z.array(ChengSpecRefModuleSchema).min(1),
    links: z.array(ChengSpecRefLinkSchema).min(1),
    indexCheck: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };

    const moduleIds = new Set<string>();
    const moduleNames = new Set<string>();
    value.modules.forEach((module, index) => {
      if (moduleIds.has(module.id)) {
        issue(`duplicate module id: ${module.id}`, ["modules", index, "id"]);
      }
      moduleIds.add(module.id);
      if (moduleNames.has(module.name)) {
        issue(`duplicate module name: ${module.name}`, ["modules", index, "name"]);
      }
      moduleNames.add(module.name);
    });

    const moduleById = new Map(value.modules.map((module) => [module.id, module]));
    const linkIds = new Set<string>();
    value.links.forEach((link, index) => {
      if (linkIds.has(link.id)) {
        issue(`duplicate link id: ${link.id}`, ["links", index, "id"]);
      }
      linkIds.add(link.id);
      if (link.type !== "composes") {
        return;
      }
      if (!moduleById.has(link.from)) {
        issue(`composes from is not a module id: ${link.from}`, [
          "links",
          index,
          "from",
        ]);
      }
      if (!moduleById.has(link.to)) {
        issue(`composes to is not a module id: ${link.to}`, ["links", index, "to"]);
      }
    });

    if (value.indexCheck !== (value.indexSha256 !== null)) {
      issue("indexCheck must be true exactly when indexSha256 is present", [
        "indexCheck",
      ]);
    }
    if (value.indexSha256 === null && value.indexPath !== null) {
      issue("indexPath must be null when no index is provided", ["indexPath"]);
    }
  });

export type ChengSpecRef = z.infer<typeof ChengSpecRefSchema>;

export interface ChengSpecRefParseOptions {
  /** SHA-256 of the raw spec bytes; defaults to SHA-256 of the UTF-8 text. */
  specSha256?: string;
  /** SHA-256 of the raw index bytes; defaults to SHA-256 of the UTF-8 text. */
  indexSha256?: string;
  /** Source path of the index file; text-only parses leave it null. */
  indexPath?: string | null;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function invalid(sourcePath: string, detail: string): ChengContractError {
  return new ChengContractError({
    code: "CHENG_CONTRACT_SCHEMA_INVALID",
    sourcePath,
    line: null,
    detail,
  });
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.map((segment) => String(segment)).join(".") || "<root>"}: ${issue.message}`,
    )
    .join("; ");
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

function requireRecord(
  value: unknown,
  sourcePath: string,
  where: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(sourcePath, `${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(
  jsonText: string,
  sourcePath: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw invalid(sourcePath, `invalid JSON: ${(error as Error).message}`);
  }
  return requireRecord(parsed, sourcePath, "document");
}

interface ParsedSpec {
  task: string;
  taskIndex: number;
  modules: ChengSpecRefModule[];
  links: ChengSpecRefLink[];
}

function parseSpec(specJsonText: string, sourcePath: string): ParsedSpec {
  const spec = parseJsonObject(specJsonText, sourcePath);
  if (spec.schema !== "csg.spec.v2") {
    throw invalid(
      sourcePath,
      `schema must be csg.spec.v2, got ${JSON.stringify(spec.schema)}`,
    );
  }
  const task = requireString(spec, "task", sourcePath, "spec");
  const taskIndex = NonNegativeIntSchema.safeParse(spec.task_index);
  if (!taskIndex.success) {
    throw invalid(sourcePath, "spec.task_index must be a non-negative integer");
  }
  if (!Array.isArray(spec.modules)) {
    throw invalid(sourcePath, "spec.modules must be an array");
  }
  if (!Array.isArray(spec.links)) {
    throw invalid(sourcePath, "spec.links must be an array");
  }
  if (spec.modules.length === 0) {
    throw invalid(sourcePath, "spec.modules must not be empty");
  }
  if (spec.links.length === 0) {
    throw invalid(sourcePath, "spec.links must not be empty");
  }

  const modules: ChengSpecRefModule[] = spec.modules.map((raw, index) => {
    const where = `modules[${index}]`;
    const value = requireRecord(raw, sourcePath, where);
    const role = requireString(value, "role", sourcePath, where);
    if (role !== "entry" && role !== "helper") {
      throw invalid(sourcePath, `${where}.role must be entry or helper`);
    }
    return {
      id: requireString(value, "id", sourcePath, where),
      name: requireString(value, "name", sourcePath, where),
      fnName: requireString(value, "fn", sourcePath, where),
      role,
    };
  });

  const links: ChengSpecRefLink[] = spec.links.map((raw, index) => {
    const where = `links[${index}]`;
    const value = requireRecord(raw, sourcePath, where);
    const type = SpecLinkTypeSchema.safeParse(value.type);
    if (!type.success) {
      throw invalid(
        sourcePath,
        `${where}.type must be one of implemented_by, verified_by, exercises, composes`,
      );
    }
    return {
      id: requireString(value, "id", sourcePath, where),
      from: requireString(value, "from", sourcePath, where),
      to: requireString(value, "to", sourcePath, where),
      type: type.data,
    };
  });

  return { task, taskIndex: taskIndex.data, modules, links };
}

function requireIndexShaMatch(
  indexJsonText: string,
  indexSourcePath: string,
  task: string,
  specSha256: string,
): void {
  const index = parseJsonObject(indexJsonText, indexSourcePath);
  if (index.schema !== "csg.spec.v2.index") {
    throw invalid(
      indexSourcePath,
      `index schema must be csg.spec.v2.index, got ${JSON.stringify(index.schema)}`,
    );
  }
  if (!Array.isArray(index.tasks)) {
    throw invalid(indexSourcePath, "index.tasks must be an array");
  }

  let entry: Record<string, unknown> | null = null;
  for (const [position, raw] of index.tasks.entries()) {
    const value = requireRecord(raw, indexSourcePath, `tasks[${position}]`);
    const entryTask = requireString(
      value,
      "task",
      indexSourcePath,
      `tasks[${position}]`,
    );
    if (entryTask === task) {
      entry = value;
      break;
    }
  }
  if (entry === null) {
    throw invalid(indexSourcePath, `index has no task entry for ${task}`);
  }

  const entrySha256 = Sha256Schema.safeParse(entry.sha256);
  if (!entrySha256.success) {
    throw invalid(
      indexSourcePath,
      `index entry ${task} sha256 must be a lowercase 64-hex sha256`,
    );
  }
  if (entrySha256.data !== specSha256) {
    throw invalid(
      indexSourcePath,
      `index entry ${task} sha256 ${entrySha256.data} does not match spec sha256 ${specSha256}`,
    );
  }
}

/**
 * Project `specJsonText` (and the optional `indexJsonText`) into a
 * `ChengSpecRef`. Malformed JSON, schema drift, duplicate module/link ids,
 * composes endpoints that are not modules, a missing index task entry and an
 * index sha mismatch all throw `CHENG_CONTRACT_SCHEMA_INVALID`.
 */
export function parseChengSpecRef(
  specJsonText: string,
  indexJsonText: string | null,
  sourcePath = "<memory>",
  options: ChengSpecRefParseOptions = {},
): ChengSpecRef {
  if (indexJsonText === null) {
    if (options.indexSha256 !== undefined) {
      throw invalid(sourcePath, "indexSha256 was provided without index JSON");
    }
    if (options.indexPath !== undefined && options.indexPath !== null) {
      throw invalid(sourcePath, "indexPath was provided without index JSON");
    }
  }

  const specSha256 =
    options.specSha256 ?? sha256Hex(Buffer.from(specJsonText, "utf8"));
  const spec = parseSpec(specJsonText, sourcePath);

  let indexPath: string | null = null;
  let indexSha256: string | null = null;
  if (indexJsonText !== null) {
    indexSha256 =
      options.indexSha256 ?? sha256Hex(Buffer.from(indexJsonText, "utf8"));
    indexPath = options.indexPath ?? null;
    const indexSourcePath = indexPath ?? "<memory:index>";
    requireIndexShaMatch(
      indexJsonText,
      indexSourcePath,
      spec.task,
      specSha256,
    );
  }

  const result = ChengSpecRefSchema.safeParse({
    kind: "cheng_spec_ref",
    schema: "cheng.contract.cheng_spec_ref.v1",
    task: spec.task,
    taskIndex: spec.taskIndex,
    specPath: sourcePath,
    specSha256,
    indexPath,
    indexSha256,
    modules: spec.modules,
    links: spec.links,
    indexCheck: indexSha256 !== null,
  });
  if (!result.success) {
    throw invalid(sourcePath, formatIssues(result.error));
  }
  return result.data;
}
