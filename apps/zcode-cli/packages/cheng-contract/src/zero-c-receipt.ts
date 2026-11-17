import { z } from "zod";

import { NonNegativeIntSchema, Sha256Schema } from "./primitives.js";

export const DonorProvenanceRowSchema = z
  .object({
    index: z.number().int().positive(),
    kind: z.string().min(1),
    objectSha256: Sha256Schema,
    source: z.string().min(1),
    sourceSha256: Sha256Schema,
    compilerSha256: Sha256Schema,
  })
  .strict();

export type DonorProvenanceRow = z.infer<typeof DonorProvenanceRowSchema>;

export const ZeroCChecksSchema = z
  .object({
    coldProviderZero: z.boolean(),
    cBackendZero: z.boolean(),
    orcZero: z.boolean(),
    cProviderObjectsZero: z.boolean(),
    linkCountMatchesDonors: z.boolean(),
    donorsCompilerShaMatched: z.boolean(),
    zeroCProductionOk: z.boolean(),
  })
  .strict();

export type ZeroCChecks = z.infer<typeof ZeroCChecksSchema>;

export const ZeroCReceiptSchema = z
  .object({
    schema: z.literal("cheng.contract.zero_c.v1"),
    coldProviderUsed: NonNegativeIntSchema,
    cBackendUsed: NonNegativeIntSchema,
    orcUsed: NonNegativeIntSchema,
    linkObjectCount: NonNegativeIntSchema,
    pureChengDonorCount: NonNegativeIntSchema,
    cProviderObjectCount: NonNegativeIntSchema,
    driverProviderObjectCount: NonNegativeIntSchema,
    coldSystemLinkExec: NonNegativeIntSchema,
    realBackendCodegen: NonNegativeIntSchema,
    expectedDriverSha256: Sha256Schema.nullable(),
    donors: z.array(DonorProvenanceRowSchema),
    checks: ZeroCChecksSchema,
  })
  .strict();

export type ZeroCReceipt = z.infer<typeof ZeroCReceiptSchema>;
