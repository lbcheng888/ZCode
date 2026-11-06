import { z } from "zod";

export const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "expected a lowercase 64-hex sha256");

export const Sha256OrDashSchema = z.union([Sha256Schema, z.literal("-")]);

export const NonNegativeIntSchema = z.number().int().nonnegative();

export const TaskNameSchema = z.string().min(1);

export const SemanticStatusSchema = z.enum(["semantic_pass", "semantic_fail"]);

export const ProgJudgeSchema = z.enum(["semantic_pass", "semantic_fail", "pending"]);

export const ProgStatusSchema = z.enum(["judged", "pending"]);

export const ModuleVerdictSchema = z.enum(["pass", "fail", "-"]);

export const ModuleRoleSchema = z.enum(["entry", "helper"]);
