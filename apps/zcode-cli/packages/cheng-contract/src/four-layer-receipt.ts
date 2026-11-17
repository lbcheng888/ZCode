import { z } from "zod";

import { NonNegativeIntSchema, Sha256Schema } from "./primitives.js";

const FourLayerModuleReceiptSchema = z
  .object({
    source: z.string().min(1),
    line_count: NonNegativeIntSchema,
    obj: z.string().min(1),
    obj_bytes: NonNegativeIntSchema,
    obj_sha256: Sha256Schema,
    compile_maxrss_bytes: NonNegativeIntSchema,
    text_bytes: NonNegativeIntSchema,
    data_bytes: NonNegativeIntSchema,
    bss_bytes: NonNegativeIntSchema,
  })
  .strict();

const FourLayerBinaryReceiptSchema = z
  .object({
    source: z.string().min(1),
    binary: z.string().min(1),
    binary_sha256: Sha256Schema,
    total_link_objects: NonNegativeIntSchema,
    compile_maxrss_bytes: NonNegativeIntSchema,
    run1_maxrss_bytes: NonNegativeIntSchema,
    run2_maxrss_bytes: NonNegativeIntSchema,
    dual_run_byte_identical: z.boolean(),
    stdout: z.string(),
  })
  .strict();

export const FourLayerCycleReceiptSchema = z
  .object({
    schema: z.literal("cheng.four_layer_r2_receipt.v1"),
    git_head: z.string().regex(/^[0-9a-f]{40}$/u),
    car_bin: z.string().min(1),
    car_sha256: Sha256Schema,
    linker_bin: z.string().min(1),
    supplies_list: z.string().min(1),
    supplies_count: NonNegativeIntSchema,
    rss_limit_bytes: NonNegativeIntSchema,
    stage3_r4_gates: z
      .object({
        mirror_manifest: z.string().min(1),
        ci_gate_quick: z.string().min(1),
        admission_order_contract: z.string().min(1),
        m3_test_f19: z.string().min(1),
        freeze_31_data_files_drift: NonNegativeIntSchema,
      })
      .strict(),
    i1_counterexample_loop: z
      .object({
        o0_cases: NonNegativeIntSchema,
        o1_cases: NonNegativeIntSchema,
        o0_subset_of_o1: z.boolean(),
        false_accept_o0: NonNegativeIntSchema,
        false_accept_o1: NonNegativeIntSchema,
        kill_rate_o0_permille: NonNegativeIntSchema,
        kill_rate_o1_permille: NonNegativeIntSchema,
        sound_candidate_o1_pass: z.string().min(1),
        forbidden_holdout_reads: NonNegativeIntSchema,
        o1_sha256: Sha256Schema,
      })
      .strict(),
    sleep_library: z
      .object({
        seed: z.string().min(1),
        seed_sha256: Sha256Schema,
        ledger: z.string().min(1),
        macro_count: NonNegativeIntSchema,
        net_savings: z.number().int(),
        forbidden_holdout_reads: NonNegativeIntSchema,
      })
      .strict(),
    csg_production: z
      .object({
        donors_list: z.string().min(1),
        donor_provenance: z.string().min(1),
        report: z.string().min(1),
        report_sha256: Sha256Schema,
        production_acceptance: NonNegativeIntSchema,
        cold_provider_used: NonNegativeIntSchema,
        c_backend_used: NonNegativeIntSchema,
        orc_used: NonNegativeIntSchema,
        tasks: z.array(z.string().min(1)),
        liblearn_cross_integration: z
          .object({
            report: z.string().min(1),
            report_sha256: Sha256Schema,
            production_acceptance: NonNegativeIntSchema,
            verdict: z.string().min(1),
          })
          .strict(),
      })
      .strict(),
    modules: z.record(z.string(), FourLayerModuleReceiptSchema),
    binaries: z.record(z.string(), FourLayerBinaryReceiptSchema),
    verdict: z.enum(["PASS", "FAIL"]),
  })
  .strict();

export type FourLayerCycleReceipt = z.infer<typeof FourLayerCycleReceiptSchema>;
