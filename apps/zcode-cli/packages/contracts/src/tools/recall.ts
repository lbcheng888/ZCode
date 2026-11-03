// ============================================================
// Recall Tool - 引用图链式召回的资源 ID 与工具契约（M9）
// ============================================================
// 稳定 ID 是注入面与完整内容之间的唯一铰链：注入只给「ID + 摘要 + 下一跳 ID」，
// 完整内容留在窗口外，模型经本工具分页取回。每个 refs 里的 ID 都必须能用同一次
// Recall 的 ids 模式再次解析（链式召回归一不变量，spec：
// docs/architecture/super-agent-context-recall-spec.md）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const RECALL_TOOL_NAME = "Recall";

export const RECALL_RESOURCE_KINDS = [
  "session",
  "target",
  "target-event",
  "wf-run",
  "wf-event",
  "artifact",
  // 预留：super-agent storage lane 的端口接入 ToolExecutionContext 后启用；
  // 在那之前解析这两个 kind 返回 capability_absent（诚实的能力缺席，不是降级）。
  "trigger",
  "subscription",
] as const;

export type RecallResourceKind = (typeof RECALL_RESOURCE_KINDS)[number];

export const RECALL_IDS_MAX = 32;
export const RECALL_PAGE_LIMIT_MIN = 1;
export const RECALL_PAGE_LIMIT_MAX = 50;
export const RECALL_PAGE_LIMIT_DEFAULT = 20;
/** 文本页字符预算（dsh orchestrator_read 同档：默认 4000、上限 8000）。 */
export const RECALL_TEXT_PAGE_CHARS_DEFAULT = 4_000;
export const RECALL_TEXT_PAGE_CHARS_MAX = 8_000;
/** 单 item summary 的硬界：一页要装下多个 item，摘要不能反客为主。 */
export const RECALL_ITEM_SUMMARY_MAX_CHARS = 600;
/** kinds 列表面：target 是每会话单行实体；wf-event/artifact 只走 ids 模式。 */
export const RECALL_LISTABLE_KINDS = [
  "session",
  "target",
  "target-event",
  "wf-run",
] as const;
export type RecallListableKind = (typeof RECALL_LISTABLE_KINDS)[number];

export function isRecallListableKind(kind: string): kind is RecallListableKind {
  return (RECALL_LISTABLE_KINDS as readonly string[]).includes(kind);
}

const OPAQUE_ID_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SESSION_ID_SEGMENT = /^sess_[A-Za-z0-9._-]+$/;
const TARGET_ID_SEGMENT = /^target_[A-Za-z0-9._-]+$/;
const POSITIVE_INT_SEGMENT = /^\d+$/;

export interface ParsedRecallResourceId {
  kind: RecallResourceKind;
  /** kind 内的裸 ID（不含 kind 前缀）；复合 ID（target-event / wf-event / artifact）为完整剩余部分。 */
  id: string;
  /** 复合 ID 的分段：target-event=[targetId, n]、wf-event=[runId, seq]、artifact=[sessionId, artifactId]。 */
  segments: readonly string[];
}

/**
 * 解析 `<kind>:<id>`。返回 undefined 表示形态非法——调用方（schema 与 handler）对
 * 非法 ID 的处理一致：响亮拒绝，不猜、不归一到别的 kind。
 */
export function parseRecallResourceId(value: string): ParsedRecallResourceId | undefined {
  const colonIndex = value.indexOf(":");
  if (colonIndex <= 0) return undefined;
  const kind = value.slice(0, colonIndex);
  const id = value.slice(colonIndex + 1);
  if (id.length === 0) return undefined;

  switch (kind) {
    case "session": {
      if (!SESSION_ID_SEGMENT.test(id)) return undefined;
      return { kind, id, segments: [id] };
    }
    case "target": {
      if (!TARGET_ID_SEGMENT.test(id)) return undefined;
      return { kind, id, segments: [id] };
    }
    case "target-event": {
      const slashIndex = id.lastIndexOf("/");
      if (slashIndex <= 0) return undefined;
      const targetId = id.slice(0, slashIndex);
      const sequence = id.slice(slashIndex + 1);
      if (!TARGET_ID_SEGMENT.test(targetId) || !POSITIVE_INT_SEGMENT.test(sequence)) {
        return undefined;
      }
      return { kind, id, segments: [targetId, sequence] };
    }
    case "wf-run": {
      if (!OPAQUE_ID_SEGMENT.test(id)) return undefined;
      return { kind, id, segments: [id] };
    }
    case "wf-event": {
      const slashIndex = id.lastIndexOf("/");
      if (slashIndex <= 0) return undefined;
      const runId = id.slice(0, slashIndex);
      const sequence = id.slice(slashIndex + 1);
      if (!OPAQUE_ID_SEGMENT.test(runId) || !POSITIVE_INT_SEGMENT.test(sequence)) {
        return undefined;
      }
      return { kind, id, segments: [runId, sequence] };
    }
    case "artifact": {
      const slashIndex = id.indexOf("/");
      if (slashIndex <= 0 || slashIndex === id.length - 1) return undefined;
      const sessionId = id.slice(0, slashIndex);
      const artifactId = id.slice(slashIndex + 1);
      if (!SESSION_ID_SEGMENT.test(sessionId) || !OPAQUE_ID_SEGMENT.test(artifactId)) {
        return undefined;
      }
      return { kind, id, segments: [sessionId, artifactId] };
    }
    case "trigger":
    case "subscription": {
      if (!OPAQUE_ID_SEGMENT.test(id)) return undefined;
      return { kind, id, segments: [id] };
    }
    default:
      return undefined;
  }
}

export function formatRecallResourceId(
  kind: RecallResourceKind,
  segments: readonly string[],
): string {
  return `${kind}:${segments.join("/")}`;
}

/** 溢写产物 URI（`zcode-artifact://<session>/<id>`）与 artifact 召回 ID 一一对应。 */
export const RECALL_ARTIFACT_URI_SCHEME = "zcode-artifact://";

export function recallArtifactIdFromUri(uri: string): string | undefined {
  if (!uri.startsWith(RECALL_ARTIFACT_URI_SCHEME)) return undefined;
  const rest = uri.slice(RECALL_ARTIFACT_URI_SCHEME.length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex <= 0 || slashIndex === rest.length - 1) return undefined;
  const sessionId = decodeURIComponent(rest.slice(0, slashIndex));
  const artifactId = decodeURIComponent(rest.slice(slashIndex + 1));
  const parsed = parseRecallResourceId(`artifact:${sessionId}/${artifactId}`);
  return parsed ? parsed.id : undefined;
}

export function recallArtifactUriFromId(id: string): string | undefined {
  const parsed = parseRecallResourceId(id.startsWith("artifact:") ? id : `artifact:${id}`);
  if (!parsed || parsed.kind !== "artifact") return undefined;
  return `${RECALL_ARTIFACT_URI_SCHEME}${encodeURIComponent(parsed.segments[0])}/${encodeURIComponent(parsed.segments[1])}`;
}

/**
 * 归一模型可能拿到的两种写法：溢写结果里出现的是 `zcode-artifact://` URI，
 * 召回 ID 是 `artifact:<session>/<id>`——两者必须是同一个资源（M9：artifact URI
 * 必须是 recall 可解析 ID）。其余 ID 原样返回。
 */
export function normalizeRecallResourceId(value: string): string {
  if (value.startsWith(RECALL_ARTIFACT_URI_SCHEME)) {
    const artifactId = recallArtifactIdFromUri(value);
    if (artifactId !== undefined) return `artifact:${artifactId}`;
  }
  return value;
}

export const RecallResourceIdSchema = z
  .string()
  .max(512)
  .refine((value) => parseRecallResourceId(normalizeRecallResourceId(value)) !== undefined, {
    message:
      "Recall resource IDs must look like <kind>:<id> (see RECALL_RESOURCE_KINDS); zcode-artifact:// URIs are accepted as artifact ids.",
  });

export const RecallInputSchema = z
  .object({
    ids: z
      .array(RecallResourceIdSchema)
      .min(1)
      .max(RECALL_IDS_MAX)
      .optional()
      .describe(
        "Resource IDs to resolve directly. Every id shown on a previous page (item.refs, recallSeedIds) resolves here — follow refs to walk the reference graph.",
      ),
    kind: z
      .enum(RECALL_RESOURCE_KINDS)
      .optional()
      .describe(
        "List one page of resources of this kind within the current workspace/session scope. Mutually exclusive with ids.",
      ),
    cursor: z
      .string()
      .regex(/^\d{1,10}$/, "Cursor is a decimal offset string.")
      .optional()
      .describe(
        "Opaque page cursor: listing offset for kind, character offset for a single artifact id.",
      ),
    limit: z
      .number()
      .int()
      .min(RECALL_PAGE_LIMIT_MIN)
      .max(RECALL_PAGE_LIMIT_MAX)
      .optional()
      .describe(
        `Page size for kind listings (${RECALL_PAGE_LIMIT_MIN}-${RECALL_PAGE_LIMIT_MAX}, default ${RECALL_PAGE_LIMIT_DEFAULT}). Ignored for ids.`,
      ),
  })
  .strict()
  .refine((value) => (value.ids === undefined) !== (value.kind === undefined), {
    message: "Pass exactly one of ids or kind.",
  })
  .superRefine((value, ctx) => {
    if (value.cursor === undefined || value.kind !== undefined) return;
    // ids 模式下 cursor 只服务单个 artifact 的内容续读；其它 kind 的续跳走 refs。
    const only = value.ids?.[0];
    const parsed =
      only === undefined ? undefined : parseRecallResourceId(normalizeRecallResourceId(only));
    if (!parsed || parsed.kind !== "artifact" || value.ids?.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cursor with ids only applies to a single artifact id.",
      });
    }
  });

export type RecallInput = z.infer<typeof RecallInputSchema>;

export const RecallInputJsonSchema = toToolJsonSchema(RecallInputSchema);

export const RecallItemSchema = z
  .object({
    id: z.string(),
    kind: z.enum(RECALL_RESOURCE_KINDS),
    summary: z.string(),
    /** 下一跳：每个 ID 都能用 ids 模式再次解析（链式召回归一不变量）。 */
    refs: z.array(z.string()).default([]),
    /** 该资源自身的续页 cursor（artifact 内容页）；在场时用同 id + cursor 续读。 */
    nextCursor: z.string().optional(),
  })
  .strict();

export type RecallItem = z.infer<typeof RecallItemSchema>;

export const RecallOutputSchema = z
  .object({
    status: z.enum(["success", "capability_absent", "scope_denied", "list_unsupported"]),
    items: z.array(RecallItemSchema).default([]),
    /** 续页 cursor：在场表示同参数 + 该 cursor 可取下一页。 */
    nextCursor: z.string().optional(),
    truncated: z.boolean().default(false),
    /** ids 模式下解析不到的 ID 原样回报——不吞、不猜。 */
    missing: z.array(z.string()).default([]),
    /** 业务失败时的稳定原因码（如 missing_port、not_listable）。 */
    reason: z.string().optional(),
  })
  .strict();

export type RecallOutput = z.infer<typeof RecallOutputSchema>;

export const RecallOutputJsonSchema = toToolJsonSchema(RecallOutputSchema);
