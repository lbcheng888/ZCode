import { z } from "zod";

import type { ChengError } from "./cheng-error.js";
import type { RunVolumeReceipt } from "./run-volume.js";
import type { SettleReceipt } from "./settle-receipt.js";
import type { StructureReceipt } from "./structure-receipt.js";

/**
 * ChengGate：只消费结构化回执的交付/完成门（P4）。
 *
 * 输入只有四类已校验的契约对象：`ChengError`（runner 退出码经 classifyRunnerExit 分类）、
 * `RunVolumeReceipt`（judge/prog/acceptance）、`SettleReceipt`、`StructureReceipt`。
 * 不读日志文本、不猜、不因“看起来像成功”而放行：
 * - 诊断绿只返回 `DIAGNOSTIC_NOT_ACCEPTANCE`，永远不是 `PRODUCTION`；
 * - 生产绿还要求 manifest 完整（显式传入的 runtime manifest 检查结果）；
 * - 单模块 run 没有 modules.tsv：诊断档允许 `structure=null`，生产档拒绝。
 */
export interface ChengGateInput {
  readonly error: ChengError | null;
  readonly run: RunVolumeReceipt | null;
  readonly settle: SettleReceipt | null;
  readonly structure: StructureReceipt | null;
  readonly mode: "diagnostic" | "production";
  /** 生产档必需：RuntimeManifest 校验是否完整；诊断档忽略。 */
  readonly runtimeManifestComplete?: boolean | null;
}

export const ChengGateLevelSchema = z.enum([
  "PRODUCTION",
  "DIAGNOSTIC_NOT_ACCEPTANCE",
  "BLOCKED",
]);
export type ChengGateLevel = z.infer<typeof ChengGateLevelSchema>;

export const ChengGateResultSchema = z
  .object({
    ok: z.boolean(),
    level: ChengGateLevelSchema,
    reasons: z.array(z.string()),
  })
  .strict();
export type ChengGateResult = z.infer<typeof ChengGateResultSchema>;

export function evaluateChengGate(input: ChengGateInput): ChengGateResult {
  const reasons: string[] = [];
  if (input.error !== null) {
    reasons.push(`runner_rc=${String(input.error.code)}`, `error_class=${input.error.class}`);
  }
  if (input.run === null) {
    reasons.push("run_volume_missing");
  } else {
    const receipt = input.run;
    if (!receipt.checks.judgeRowsDeclared) reasons.push("judge_rows_undeclared");
    if (!receipt.checks.programShaPresent) reasons.push("program_sha_missing");
    if (!receipt.checks.programShaMatchesProg) reasons.push("program_sha_mismatch");
    if (!receipt.checks.acceptanceClassified) reasons.push("acceptance_unclassified");
    for (const judge of receipt.judge) {
      if (judge.status !== "semantic_pass") reasons.push(`judge_not_semantic_pass:${judge.task}`);
      if (judge.compileRc !== 0) reasons.push(`compile_rc:${judge.task}:${String(judge.compileRc)}`);
      if (judge.runRc !== 0) reasons.push(`run_rc:${judge.task}:${String(judge.runRc)}`);
    }
  }

  if (input.settle === null) {
    reasons.push("settle_receipt_missing");
  } else {
    const settle = input.settle;
    if (!settle.traceDone.solved) reasons.push("settle_not_solved");
    if (settle.traceDone.invalidPath) reasons.push("settle_invalid_path");
    if (settle.traceDone.settleFailed) reasons.push("settle_failed");
    if (!settle.traceDone.programAuthenticated) reasons.push("program_not_authenticated");
    if (settle.traceDone.finalExamples === 0) reasons.push("settle_zero_examples");
    if (settle.traceDone.finalPassed !== settle.traceDone.finalExamples) {
      reasons.push("settle_final_counts_mismatch");
    }
    for (const event of settle.settles) {
      if (event.verdict !== "pass") {
        reasons.push(`settle_verdict:${event.kind}:${event.fn}`);
      }
    }
    const program = settle.settles.find((event) => event.kind === "program");
    if (program === undefined) {
      reasons.push("settle_program_event_missing");
    } else if (program.kind === "program" && program.examples !== settle.traceDone.finalExamples) {
      reasons.push("settle_program_examples_mismatch");
    }
  }

  if (input.structure === null) {
    // 单模块 run 不产 modules.tsv：诊断档允许，生产档必须 fail-closed。
    if (input.mode === "production") reasons.push("structure_missing");
  } else if (!input.structure.checks.structureGateOk) {
    reasons.push("structure_gate_false");
  }

  if (input.run !== null) {
    const acceptance = input.run.acceptance;
    if (input.mode === "production") {
      if (acceptance.level !== "PRODUCTION") reasons.push(`acceptance_level:${acceptance.level}`);
      if (acceptance.productionAcceptance !== true) reasons.push("production_acceptance_false");
      if (acceptance.verdict !== "PASS") reasons.push(`verdict:${acceptance.verdict ?? "null"}`);
      if (input.runtimeManifestComplete !== true) reasons.push("runtime_manifest_incomplete");
    } else if (acceptance.level !== "DIAGNOSTIC_NOT_ACCEPTANCE") {
      reasons.push(`acceptance_level:${acceptance.level}`);
    } else if (acceptance.productionAcceptance !== false) {
      reasons.push("diagnostic_production_acceptance_must_be_false");
    }
  }

  if (reasons.length > 0) {
    return { ok: false, level: "BLOCKED", reasons };
  }
  return {
    ok: true,
    level: input.mode === "production" ? "PRODUCTION" : "DIAGNOSTIC_NOT_ACCEPTANCE",
    reasons: [],
  };
}
