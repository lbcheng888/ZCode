import { z } from "zod";

import { NonNegativeIntSchema, Sha256Schema } from "./primitives.js";

export const SurfaceViolationSchema = z
  .object({
    code: z.string().min(1),
    line: NonNegativeIntSchema,
    column: NonNegativeIntSchema.optional(),
    message: z.string().min(1),
    source: z.enum(["v4", "budget", "line_cap"]),
  })
  .strict();

export type SurfaceViolation = z.infer<typeof SurfaceViolationSchema>;

export const ChengSurfaceReportSchema = z
  .object({
    schema: z.literal("cheng.contract.surface_report.v1"),
    filePath: z.string().min(1),
    fileSha256: Sha256Schema,
    v4Ok: z.boolean(),
    budgetOk: z.boolean(),
    lineCount: NonNegativeIntSchema,
    lineCapOk: z.boolean(),
    ok: z.boolean(),
    violations: z.array(SurfaceViolationSchema).max(64),
    truncatedCount: NonNegativeIntSchema,
  })
  .strict();

export type ChengSurfaceReport = z.infer<typeof ChengSurfaceReportSchema>;
