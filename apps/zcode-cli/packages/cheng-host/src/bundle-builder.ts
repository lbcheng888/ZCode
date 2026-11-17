import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "./canonical.js";
import { HostError } from "./errors.js";
import type { BundlePrepareResult, ChengSpecDraft } from "./protocol.js";

const TASK_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const SCALAR_TYPES = new Set([
  "int",
  "int32",
  "int64",
  "uint",
  "uint32",
  "uint64",
  "i32",
  "i64",
  "u32",
  "u64",
  "bool",
]);

export const MAX_BUNDLE_BYTES = 256 * 1024;
export const MAX_BUNDLES_COUNT = 512;
export const MAX_BUNDLES_TOTAL_BYTES = 128 * 1024 * 1024;

interface BundleFile {
  readonly relPath: string;
  readonly content: string;
}

/**
 * Validate a ChengSpecDraft upfront (before any disk write) using:
 * - strict task identifier regex
 * - settle-only oracle & scalar M5 emission-face check
 * - Kahn + 3-color DFS cycle detection on `composes` links
 */
export function validateChengSpecDraft(draft: ChengSpecDraft): void {
  if (!TASK_NAME_RE.test(draft.task)) {
    throw new HostError(
      "host.invalidParams",
      `invalid task name ${JSON.stringify(draft.task)}: must match ^[a-z][a-z0-9_]{0,62}$ (no hyphens)`,
      { evidence: [`task=${draft.task}`] },
    );
  }
  if (draft.oracle !== undefined && draft.oracle.kind !== "settle") {
    throw new HostError(
      "host.invalidParams",
      `unsupported oracle.kind=${draft.oracle.kind}: Track I CSG-AST requires oracle.kind="settle"`,
      { evidence: [`oracle.kind=${draft.oracle.kind}`] },
    );
  }

  const moduleIds = new Set<string>();
  for (const mod of draft.modules) {
    if (moduleIds.has(mod.id)) {
      throw new HostError("host.invalidParams", `duplicate module id: ${mod.id}`);
    }
    moduleIds.add(mod.id);

    if (!SCALAR_TYPES.has(mod.interface.returnType)) {
      throw new HostError(
        "host.invalidParams",
        `unsupported returnType ${JSON.stringify(mod.interface.returnType)} in module ${mod.id}: M5 scalar emission supports scalar types only; use Track II (.cheng + ChengProbeLeaf)`,
        { evidence: [`module=${mod.id}`, `returnType=${mod.interface.returnType}`] },
      );
    }
    for (const param of mod.interface.params) {
      if (!SCALAR_TYPES.has(param.type)) {
        throw new HostError(
          "host.invalidParams",
          `unsupported param type ${JSON.stringify(param.type)} for ${param.name} in module ${mod.id}: M5 scalar emission supports scalar types only; use Track II`,
          { evidence: [`module=${mod.id}`, `param=${param.name}`, `type=${param.type}`] },
        );
      }
    }
  }

  // Kahn + 3-color DFS cycle detection on composes edges.
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of moduleIds) {
    adj.set(id, []);
    inDegree.set(id, 0);
  }
  for (const link of draft.links) {
    if (link.type !== "composes") {
      continue;
    }
    if (!moduleIds.has(link.from) || !moduleIds.has(link.to)) {
      throw new HostError(
        "host.invalidParams",
        `composes link references unknown module: ${link.from} -> ${link.to}`,
      );
    }
    adj.get(link.from)!.push(link.to);
    inDegree.set(link.to, (inDegree.get(link.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
    }
  }
  let visitedCount = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visitedCount += 1;
    for (const next of adj.get(node) ?? []) {
      const nextDeg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nextDeg);
      if (nextDeg === 0) {
        queue.push(next);
      }
    }
  }

  if (visitedCount < moduleIds.size) {
    const cycle = findCycleDfs(moduleIds, adj);
    throw new HostError(
      "host.invalidParams",
      `cyclic composes dependency detected: ${cycle.join(" -> ")}`,
      { evidence: [`cycle=${cycle.join("->")}`] },
    );
  }
}

function findCycleDfs(nodes: Set<string>, adj: Map<string, string[]>): string[] {
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  for (const n of nodes) color.set(n, 0);

  const dfs = (u: string): string[] | null => {
    color.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) {
        const idx = stack.indexOf(v);
        return [...stack.slice(idx), v];
      }
      if (c === 0) {
        const found = dfs(v);
        if (found !== null) return found;
      }
    }
    stack.pop();
    color.set(u, 2);
    return null;
  };

  for (const n of nodes) {
    if (color.get(n) === 0) {
      const found = dfs(n);
      if (found !== null) return found;
    }
  }
  return ["<cycle>"];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function formatCases(
  tier: "settle" | "eval",
  fn: string,
  task: string,
  cases: ChengSpecDraft["settleCases"],
): string {
  const header = "tier\tfn\targs\texpected\tsource";
  const rows = cases.map(
    (c) => `${tier}\t${fn}\t${c.args.join(",")}\t${String(c.expected)}\tdef:${task}`,
  );
  return `${[header, ...rows].join("\n")}\n`;
}

function propNameForExpected(expected: number): string {
  return expected < 0 ? `eq_m${String(Math.abs(expected))}` : `eq_${String(expected)}`;
}

function formatProps(
  fn: string,
  cases: ChengSpecDraft["settleCases"],
): string {
  const header = "tier\tfn\targs\texpected\tsource";
  const rows = cases.map((c) => {
    const propName = propNameForExpected(c.expected);
    return `property\t${fn}\t${c.args.join(",")}\t${propName}\tprop:${propName}`;
  });
  return `${[header, ...rows].join("\n")}\n`;
}

function renderSpecDefsV2Py(draft: ChengSpecDraft): string {
  const entry = draft.modules.find((m) => m.role === "entry") ?? draft.modules[0]!;
  const paramsJson = JSON.stringify(entry.interface.params);
  return [
    "# Auto-generated deterministic spec_defs_v2.py by cheng-host bundle-builder",
    "TASK_SPECS = {",
    `    ${JSON.stringify(draft.task)}: {`,
    `        "fn": ${JSON.stringify(entry.interface.fn)},`,
    `        "params": ${paramsJson},`,
    `        "return_type": ${JSON.stringify(entry.interface.returnType)},`,
    "    }",
    "}",
    "",
    "def prop_fn(name):",
    "    if name.startswith('eq_m'):",
    "        expected = -int(name[4:])",
    "        return lambda args, out: (int(out) == expected, f'got {out} expected {expected}')",
    "    if name.startswith('eq_'):",
    "        expected = int(name[3:])",
    "        return lambda args, out: (int(out) == expected, f'got {out} expected {expected}')",
    "    raise KeyError(f'unknown property: {name}')",
    "",
  ].join("\n");
}

export interface PrepareBundleOptions {
  readonly artifactRoot: string;
  readonly draft: ChengSpecDraft;
  readonly activeBundleDirs?: ReadonlySet<string>;
}

export function prepareSpecBundle(options: PrepareBundleOptions): BundlePrepareResult {
  const { artifactRoot, draft } = options;
  validateChengSpecDraft(draft);

  const task = draft.task;
  const sourceRel = `source/${task}.task.txt`;
  const settleRel = `oracle/cases/${task}.settle.cases`;
  const evalRel = `oracle/cases/${task}.eval.cases`;
  const propsRel = `oracle/props/${task}.props`;
  const specDefsRel = "oracle/spec_defs_v2.py";
  const manifestRel = "oracle/manifest.tsv";
  const specRel = `tasks/${task}.spec.json`;

  const reqLines =
    draft.requirements !== undefined && draft.requirements.length > 0
      ? draft.requirements
      : [draft.title ?? `Synthesize ${task}`];
  const taskTxt = `${reqLines.join("\n")}\n`;
  const entryModule = draft.modules.find((m) => m.role === "entry") ?? draft.modules[0]!;
  const settleText = formatCases("settle", entryModule.interface.fn, task, draft.settleCases);
  const evalCases =
    draft.evalCases !== undefined && draft.evalCases.length > 0
      ? draft.evalCases
      : draft.settleCases;
  const evalText = formatCases("eval", entryModule.interface.fn, task, evalCases);
  const propsText = formatProps(entryModule.interface.fn, draft.settleCases);
  const specDefsText = renderSpecDefsV2Py(draft);

  const manifestText = [
    "task\tsettle\teval\tref\tsha_settle\tsha_eval\tsha_ref\tn_settle\tn_eval",
    [
      task,
      settleRel,
      evalRel,
      "-",
      sha256(settleText),
      sha256(evalText),
      "-",
      String(draft.settleCases.length),
      String(evalCases.length),
    ].join("\t"),
    "",
  ].join("\n");

  const sourceSha256 = sha256(taskTxt);
  const sigStr = (m: ChengSpecDraft["modules"][number]) =>
    `${m.interface.fn}(${m.interface.params.map((p) => `${p.name}: ${p.type}`).join(", ")}) -> ${m.interface.returnType}`;
  const specJsonObj = {
    schema: "csg.spec.v2",
    task,
    task_index: 0,
    title: draft.title ?? task,
    domain: draft.domain,
    flags: { draft_new: true },
    source: {
      path: sourceRel,
      lines: `1-${String(reqLines.length)}`,
      sha256: sourceSha256,
      quote: reqLines[0] ?? task,
    },
    requirements: reqLines.map((text, idx) => ({
      id: idx === 0 ? `req.${task}.${entryModule.interface.fn}` : `req.${task}.${entryModule.interface.fn}.${String(idx + 1)}`,
      task,
      fn: entryModule.interface.fn,
      kind: "behavior",
      text,
      signature: sigStr(entryModule),
      domain: draft.domain,
      source: {
        path: sourceRel,
        lines: `${String(idx + 1)}-${String(idx + 1)}`,
        sha256: sha256(taskTxt),
        quote: text,
      },
      status: "covered",
      notes: "",
    })),
    modules: draft.modules.map((m, idx) => ({
      id: m.id,
      task,
      name: m.interface.fn,
      role: m.role ?? (idx === 0 ? "entry" : "helper"),
      fn: m.interface.fn,
      interface: {
        signature: sigStr(m),
        params: m.interface.params,
        returns: m.interface.returnType,
        returnType: m.interface.returnType,
      },
      impl: { kind: "draft_unowned" },
      status: "draft",
    })),
    assertions: [
      {
        id: `ast.${task}.${entryModule.interface.fn}.eval`,
        task,
        fn: entryModule.interface.fn,
        kind: "eval",
        requirement_ids: [`req.${task}.${entryModule.interface.fn}`],
        module_ids: [entryModule.id],
        oracle: {
          path: evalRel,
          sha256: sha256(evalText),
          tier: "eval",
          rows: evalCases.length,
        },
        evidence: {
          kind: "draft_unowned",
          program: {
            path: sourceRel,
            sha256: sourceSha256,
          },
        },
        status: "pass",
        flags: [],
        notes: "",
      },
      {
        id: `ast.${task}.${entryModule.interface.fn}.settle`,
        task,
        fn: entryModule.interface.fn,
        kind: "settle",
        requirement_ids: [`req.${task}.${entryModule.interface.fn}`],
        module_ids: [entryModule.id],
        oracle: {
          path: settleRel,
          sha256: sha256(settleText),
          tier: "settle",
          rows: draft.settleCases.length,
        },
        evidence: {
          kind: "draft_unowned",
          program: {
            path: sourceRel,
            sha256: sourceSha256,
          },
        },
        status: "pass",
        flags: [],
        notes: "",
      },
      {
        id: `ast.${task}.${entryModule.interface.fn}.property`,
        task,
        fn: entryModule.interface.fn,
        kind: "property",
        requirement_ids: [`req.${task}.${entryModule.interface.fn}`],
        module_ids: [entryModule.id],
        oracle: {
          path: propsRel,
          sha256: sha256(propsText),
          tier: "property",
          rows: draft.settleCases.length,
        },
        evidence: {
          kind: "draft_unowned",
          program: {
            path: sourceRel,
            sha256: sourceSha256,
          },
        },
        status: "pass",
        flags: [],
        notes: "",
      },
    ],
    links:
      draft.links.length > 0
        ? draft.links.map((l, idx) => ({
            id: l.id ?? `link_${String(idx + 1)}`,
            from: l.from,
            to: l.to,
            type: l.type,
          }))
        : [
            {
              id: `link.${task}.impl.1`,
              from: `req.${task}.${entryModule.interface.fn}`,
              to: entryModule.id,
              type: "implemented_by",
            },
            {
              id: `link.${task}.verify.1`,
              from: `req.${task}.${entryModule.interface.fn}`,
              to: `ast.${task}.${entryModule.interface.fn}.eval`,
              type: "verified_by",
            },
            {
              id: `link.${task}.exercise.1`,
              from: `ast.${task}.${entryModule.interface.fn}.eval`,
              to: entryModule.id,
              type: "exercises",
            },
          ],
    oracle: {
      kind: "settle",
      path: settleRel,
      eval_path: evalRel,
      manifest_path: manifestRel,
      defs_path: specDefsRel,
    },
  };
  const specText = `${JSON.stringify(specJsonObj, null, 2)}\n`;
  const specSha256 = sha256(specText);

  const indexObj = {
    schema: "csg.spec.v2.index",
    tasks: [
      {
        task,
        task_index: 0,
        spec: specRel,
        sha256: specSha256,
      },
    ],
  };
  const indexText = `${JSON.stringify(indexObj, null, 2)}\n`;

  const files: BundleFile[] = [
    { relPath: "index.json", content: indexText },
    { relPath: specRel, content: specText },
    { relPath: sourceRel, content: taskTxt },
    { relPath: settleRel, content: settleText },
    { relPath: evalRel, content: evalText },
    { relPath: propsRel, content: propsText },
    { relPath: specDefsRel, content: specDefsText },
    { relPath: manifestRel, content: manifestText },
  ];

  let totalBytes = 0;
  for (const f of files) {
    totalBytes += Buffer.byteLength(f.content, "utf8");
  }
  if (totalBytes > MAX_BUNDLE_BYTES) {
    throw new HostError(
      "host.invalidParams",
      `bundle size ${String(totalBytes)} bytes exceeds ${String(MAX_BUNDLE_BYTES)} byte cap`,
      { evidence: [`bytes=${String(totalBytes)}`, `cap=${String(MAX_BUNDLE_BYTES)}`] },
    );
  }

  const bundleSha256 = sha256(
    canonicalJson(files.map((f) => [f.relPath, sha256(f.content)])),
  );
  const bundlesRoot = join(artifactRoot, "bundles");
  const bundleDir = join(bundlesRoot, bundleSha256);
  const specPath = join(bundleDir, specRel);

  if (existsSync(join(bundleDir, "index.json")) && existsSync(specPath)) {
    try {
      const now = new Date();
      utimesSync(bundleDir, now, now);
    } catch {
      // Best-effort LRU touch.
    }
    return {
      bundleSha256,
      bundleDir,
      specPath,
      task,
      cached: true,
    };
  }

  mkdirSync(bundlesRoot, { recursive: true, mode: 0o700 });
  const tmpDir = join(bundlesRoot, `.tmp-${bundleSha256}-${String(process.pid)}`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

  for (const f of files) {
    const target = join(tmpDir, f.relPath);
    mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(target, f.content, { encoding: "utf8", mode: 0o600 });
  }

  if (!existsSync(bundleDir)) {
    renameSync(tmpDir, bundleDir);
  } else {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  gcBundlesLru(bundlesRoot, options.activeBundleDirs ?? new Set());

  return {
    bundleSha256,
    bundleDir,
    specPath,
    task,
    cached: false,
  };
}

function gcBundlesLru(bundlesRoot: string, activeBundleDirs: ReadonlySet<string>): void {
  let entries: string[];
  try {
    entries = readdirSync(bundlesRoot).filter((name) => /^[0-9a-f]{64}$/.test(name));
  } catch {
    return;
  }

  const items: Array<{ dir: string; mtimeMs: number; bytes: number }> = [];
  let totalBytes = 0;
  for (const name of entries) {
    const dir = join(bundlesRoot, name);
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      const bytes = dirSizeBytes(dir);
      totalBytes += bytes;
      items.push({ dir, mtimeMs: st.mtimeMs, bytes });
    } catch {
      // Skip unreadable entry.
    }
  }

  if (items.length <= MAX_BUNDLES_COUNT && totalBytes <= MAX_BUNDLES_TOTAL_BYTES) {
    return;
  }

  items.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let remainingCount = items.length;
  for (const item of items) {
    if (remainingCount <= MAX_BUNDLES_COUNT && totalBytes <= MAX_BUNDLES_TOTAL_BYTES) {
      break;
    }
    if (activeBundleDirs.has(item.dir)) {
      continue;
    }
    try {
      rmSync(item.dir, { recursive: true, force: true });
      remainingCount -= 1;
      totalBytes -= item.bytes;
    } catch {
      // Ignore concurrent removal.
    }
  }
}

function dirSizeBytes(dir: string): number {
  let sum = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      sum += dirSizeBytes(p);
    } else if (entry.isFile()) {
      sum += statSync(p).size;
    }
  }
  return sum;
}
