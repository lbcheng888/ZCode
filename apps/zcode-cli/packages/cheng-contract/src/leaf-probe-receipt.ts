import { z } from "zod";

import { NonNegativeIntSchema, Sha256Schema } from "./primitives.js";

export const ChengLeafProbeReceiptSchema = z
  .object({
    schema: z.literal("cheng.contract.leaf_probe.v1"),
    filePath: z.string().min(1),
    driverSha256: Sha256Schema,
    exitCode: z.number().int(),
    objPath: z.string().min(1).nullable(),
    objBytes: NonNegativeIntSchema,
    compileMaxRssBytes: NonNegativeIntSchema,
    wallMs: NonNegativeIntSchema,
    admissionTicketId: z.string().min(1).nullable(),
    ok: z.boolean(),
    firstError: z.string().min(1).nullable(),
  })
  .strict();

export type ChengLeafProbeReceipt = z.infer<typeof ChengLeafProbeReceiptSchema>;
