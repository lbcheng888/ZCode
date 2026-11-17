import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  ChengLeafProbeReceiptSchema,
  ChengSurfaceReportSchema,
  type ChengLeafProbeReceipt,
  type ChengSurfaceReport,
  type SurfaceViolation,
} from "@zcode/cheng-contract";

import { HostError } from "./errors.js";
import type { EvolveResult } from "./protocol.js";
import { sha256File, type RuntimePin } from "./runtime.js";

const MAX_SURFACE_VIOLATIONS = 64;
const MAX_LINE_CAP = 3000;
const LEAF_PROBE_RSS_CAP_BYTES = 805_306_368; // 768 MiB

const CLOSURE_ROOT_SUFFIXES = [
  "kernel/driver/selfhost_main.cheng",
  "src/core/tooling/system_link_exec_pure_main.cheng",
  "src/core/tooling/backend_driver_dispatch_min.cheng",
] as const;

export function runSurfaceCheck(pin: RuntimePin, rawFilePath: string): ChengSurfaceReport {
  let filePath: string;
  try {
    filePath = realpathSync(resolve(rawFilePath));
    if (!statSync(filePath).isFile()) {
      throw new Error("not a regular file");
    }
  } catch (error) {
    throw new HostError("host.invalidParams", `surface.check file not found: ${rawFilePath}`, {
      evidence: [error instanceof Error ? error.message : String(error)],
    });
  }

  const content = readFileSync(filePath, "utf8");
  const fileSha256 = sha256File(filePath);
  const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/u).length;
  const lineCapOk = lineCount < MAX_LINE_CAP;

  const migratorPath = join(pin.chengRoot, "tools", "cheng_v4_canonical_migrator.py");
  const budgetGatePath = join(pin.chengRoot, "tools", "core0_source_budget_gate.py");

  const violations: SurfaceViolation[] = [];
  let v4Ok = true;
  let budgetOk = true;

  if (existsSync(migratorPath)) {
    // IMPORTANT: Never pass --json to cheng_v4_canonical_migrator.py (prefix-matches --json-out).
    const res = spawnSync("python3", [migratorPath, "--check", "--verbose", filePath], {
      cwd: pin.chengRoot,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (res.status !== 0) {
      v4Ok = false;
      const lines = (res.stdout ?? "").split(/\r?\n/u);
      for (const line of lines) {
        // Format: <rel>:<line>:<col>: [<category>] ...
        const m = /:(\d+):(\d+):\s*\[([^\]]+)\]\s*(.+)$/u.exec(line);
        if (m !== null) {
          violations.push({
            code: m[3]!,
            line: Number.parseInt(m[1]!, 10),
            column: Number.parseInt(m[2]!, 10),
            message: m[4]!.trim(),
            source: "v4",
          });
        }
      }
      if (violations.length === 0) {
        violations.push({
          code: "V4_SURFACE",
          line: 1,
          message: (res.stderr || res.stdout || "v4 surface check failed").trim().slice(0, 200),
          source: "v4",
        });
      }
    }
  }

  if (existsSync(budgetGatePath)) {
    const res = spawnSync("python3", [budgetGatePath, "--policy", "strict", "--json", filePath], {
      cwd: pin.chengRoot,
      encoding: "utf8",
      timeout: 10_000,
    });
    const rawJson = (res.stdout ?? "").trim();
    if (rawJson.length > 0) {
      try {
        const parsed = JSON.parse(rawJson) as {
          verdict?: string;
          violations?: Array<{ rule?: string; line?: number; col?: number; message?: string }>;
        };
        if (parsed.verdict !== "PASS") {
          budgetOk = false;
        }
        for (const v of parsed.violations ?? []) {
          if (v.rule === "ZD01") {
            v4Ok = false;
          } else {
            budgetOk = false;
          }
          violations.push({
            code: v.rule ?? "BUDGET",
            line: typeof v.line === "number" && v.line >= 0 ? v.line : 1,
            ...(typeof v.col === "number" && v.col >= 0 ? { column: v.col } : {}),
            message: v.message ?? "budget gate violation",
            source: "budget",
          });
        }
      } catch {
        if (res.status !== 0) {
          budgetOk = false;
          violations.push({
            code: "BUDGET_PARSE",
            line: 1,
            message: rawJson.slice(0, 200),
            source: "budget",
          });
        }
      }
    } else if (res.status !== 0) {
      budgetOk = false;
      violations.push({
        code: "BUDGET_FAIL",
        line: 1,
        message: (res.stderr ?? "budget gate failed").trim().slice(0, 200),
        source: "budget",
      });
    }
  }

  if (!lineCapOk) {
    violations.push({
      code: "LINE_CAP_3000",
      line: lineCount,
      message: `file has ${String(lineCount)} lines (must be < ${String(MAX_LINE_CAP)})`,
      source: "line_cap",
    });
  }

  // Deduplicate by (code, line, source) and sort by line number.
  const seen = new Set<string>();
  const deduped: SurfaceViolation[] = [];
  for (const v of violations) {
    const key = `${v.source}:${v.code}:${String(v.line)}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(v);
    }
  }
  deduped.sort((a, b) => a.line - b.line);
  const truncatedCount = Math.max(0, deduped.length - MAX_SURFACE_VIOLATIONS);
  const bounded = deduped.slice(0, MAX_SURFACE_VIOLATIONS);
  const ok = v4Ok && budgetOk && lineCapOk;

  return ChengSurfaceReportSchema.parse({
    schema: "cheng.contract.surface_report.v1",
    filePath,
    fileSha256,
    v4Ok,
    budgetOk,
    lineCount,
    lineCapOk,
    ok,
    violations: bounded,
    truncatedCount,
  });
}

export function runLeafProbe(
  pin: RuntimePin,
  artifactRoot: string,
  rawFilePath: string,
  allowClosureProbe = false,
): ChengLeafProbeReceipt {
  let filePath: string;
  try {
    filePath = realpathSync(resolve(rawFilePath));
    if (!statSync(filePath).isFile()) {
      throw new Error("not a regular file");
    }
  } catch (error) {
    throw new HostError("host.invalidParams", `leaf.probe file not found: ${rawFilePath}`, {
      evidence: [error instanceof Error ? error.message : String(error)],
    });
  }

  const normalized = filePath.replace(/\\/gu, "/");
  if (!allowClosureProbe) {
    for (const suffix of CLOSURE_ROOT_SUFFIXES) {
      if (normalized.endsWith(`/${suffix}`) || normalized === suffix) {
        throw new HostError(
          "host.invalidParams",
          `refusing closure root ${suffix} in leaf.probe without allowClosureProbe=true`,
          { evidence: [`filePath=${filePath}`, `closureRoot=${suffix}`] },
        );
      }
    }
  }

  const driverPath = pin.productionSlot?.driverPath ?? pin.diagnosticSlot?.driverPath ?? pin.driverPath;
  const driverSha256 =
    pin.productionSlot?.driverSha256 ?? pin.diagnosticSlot?.driverSha256 ?? pin.driverSha256;

  const probeDir = join(artifactRoot, "leaf_probes");
  mkdirSync(probeDir, { recursive: true, mode: 0o700 });
  const stem = basename(filePath, ".cheng").replace(/[^A-Za-z0-9_.-]/gu, "_");
  const objPath = join(probeDir, `${stem}.${String(process.pid)}.o`);

  const admissionPath = join(pin.chengRoot, "tools", "compile_admission.sh");
  const driverArgs = [
    driverPath,
    "system-link-exec",
    `--root:${pin.chengRoot}`,
    `--in:${filePath}`,
    `--out:${objPath}`,
    "--emit:obj",
  ];
  const timedArgs =
    process.platform === "darwin" ? ["/usr/bin/time", "-l", ...driverArgs] : driverArgs;

  const cmdArgs = existsSync(admissionPath)
    ? [
        "bash",
        [
          admissionPath,
          "probe",
          "--est-bytes",
          String(LEAF_PROBE_RSS_CAP_BYTES),
          "--est-secs",
          "120",
          "--owner",
          "zcode-leaf-probe",
          "--",
          ...timedArgs,
        ],
      ] as const
    : [timedArgs[0]!, timedArgs.slice(1)] as const;

  const t0 = Date.now();
  const res = spawnSync(cmdArgs[0], [...cmdArgs[1]], {
    cwd: pin.chengRoot,
    env: {
      ...process.env,
      CHENG_PROCESS_MAX_RSS_BYTES: String(LEAF_PROBE_RSS_CAP_BYTES),
    },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const wallMs = Math.max(0, Date.now() - t0);
  const exitCode = res.status ?? (res.error ? 1 : -1);
  const stderr = res.stderr ?? "";
  const stdout = res.stdout ?? "";

  let compileMaxRssBytes = 0;
  const rssMatch = /(\d+)\s+maximum resident set size/u.exec(stderr);
  if (rssMatch !== null) {
    compileMaxRssBytes = Number.parseInt(rssMatch[1]!, 10);
  }

  const objExists = existsSync(objPath) && statSync(objPath).size > 0;
  const objBytes = objExists ? statSync(objPath).size : 0;
  const ok = exitCode === 0 && objExists && compileMaxRssBytes <= LEAF_PROBE_RSS_CAP_BYTES;

  let firstError: string | null = null;
  if (!ok) {
    const errLines = `${stderr}\n${stdout}`
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/maximum resident set size/u.test(l));
    firstError = errLines[0] ?? `leaf probe exited with code ${String(exitCode)}`;
  }

  return ChengLeafProbeReceiptSchema.parse({
    schema: "cheng.contract.leaf_probe.v1",
    filePath,
    driverSha256,
    exitCode,
    objPath: objExists ? objPath : null,
    objBytes,
    compileMaxRssBytes,
    wallMs,
    admissionTicketId: existsSync(admissionPath) ? `probe-${String(process.pid)}` : null,
    ok,
    firstError,
  });
}

export function runEvolveOp(
  pin: RuntimePin,
  kind: "counterexample" | "sleep",
  _dryRun = false,
): EvolveResult {
  const scriptName =
    kind === "counterexample" ? "csg_i1_counterexample_loop.py" : "csg_macro_library_sleep.py";
  const scriptPath = join(pin.chengRoot, "tools", scriptName);
  if (!existsSync(scriptPath)) {
    throw new HostError("host.opUnavailable", `${scriptName} not found in ${pin.chengRoot}`, {
      evidence: [`script=${scriptPath}`],
    });
  }

  const res = spawnSync("python3", [scriptPath], {
    cwd: pin.chengRoot,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });

  const exitCode = res.status ?? 1;
  const ledgerPath =
    kind === "counterexample"
      ? join(pin.chengRoot, ".c0run", "four_layer_r2", "i1_loop", "i1_i4_ledger.json")
      : join(pin.chengRoot, ".c0run", "four_layer_r2", "sleep_prior", "sleep_ledger.json");

  let summary: Record<string, unknown> = {};
  let forbiddenHoldoutReads = 0;
  if (existsSync(ledgerPath)) {
    try {
      summary = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
      const rawForbidden = summary.forbidden_holdout_reads;
      if (typeof rawForbidden === "number" && Number.isInteger(rawForbidden) && rawForbidden >= 0) {
        forbiddenHoldoutReads = rawForbidden;
      }
    } catch {
      // Handled below if exitCode !== 0 or unreadable.
    }
  }

  if (forbiddenHoldoutReads !== 0) {
    throw new HostError(
      "host.verifyUnavailable",
      `${kind} violated holdout read barrier (forbidden_holdout_reads=${String(forbiddenHoldoutReads)})`,
      { evidence: [`forbiddenHoldoutReads=${String(forbiddenHoldoutReads)}`, `ledger=${ledgerPath}`] },
    );
  }

  return {
    ok: exitCode === 0 && forbiddenHoldoutReads === 0,
    kind,
    exitCode,
    receiptRef: existsSync(ledgerPath) ? ledgerPath : null,
    forbiddenHoldoutReads,
    summary,
  };
}
