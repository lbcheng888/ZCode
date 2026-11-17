import type { ModelMessageContent } from "@zcode/contracts";
import type { ChengSurfaceReport } from "../cheng-read-port.js";
import type { ToolExecutionContext } from "../types.js";

const MAX_SURFACE_NOTICE_BYTES = 4 * 1024;
const SURFACE_WRITE_TOOLS = new Set(["Write", "Edit", "ApplyPatch"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "\n...(truncated)";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const limit = Math.max(0, maxBytes - suffixBytes);
  const buf = Buffer.from(text, "utf8");
  let end = Math.min(buf.length, limit);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8") + suffix;
}

export function extractWrittenChengFilePaths(toolName: string, output: unknown): string[] {
  if (!SURFACE_WRITE_TOOLS.has(toolName) || !isRecord(output)) return [];
  const paths = new Set<string>();

  if (toolName === "Write" || toolName === "Edit") {
    const filePath = output.filePath;
    if (typeof filePath === "string" && filePath.endsWith(".cheng")) {
      paths.add(filePath);
    }
  } else if (toolName === "ApplyPatch" && Array.isArray(output.changes)) {
    for (const change of output.changes) {
      if (!isRecord(change) || change.type === "delete") continue;
      const target = typeof change.movePath === "string" ? change.movePath : change.filePath;
      if (typeof target === "string" && target.endsWith(".cheng")) {
        paths.add(target);
      }
    }
  }

  return [...paths];
}

export function formatChengSurfaceNotice(reports: readonly ChengSurfaceReport[]): string | undefined {
  const failing = reports.filter(
    (report) => report.v4Ok === false || report.budgetOk === false || report.lineCapOk === false,
  );
  if (failing.length === 0) return undefined;

  const lines: string[] = [];
  for (const report of failing) {
    const flags: string[] = [];
    if (!report.v4Ok) flags.push("v4Ok=false");
    if (!report.budgetOk) flags.push("budgetOk=false");
    if (!report.lineCapOk) flags.push(`lineCapOk=false(lines=${report.lineCount})`);
    lines.push(`[CHENG_SURFACE_VIOLATION] ${report.filePath} (${flags.join(", ")})`);
    for (const v of report.violations) {
      const col = v.column !== undefined ? `:${v.column}` : "";
      lines.push(`  - L${v.line}${col} [${v.ruleId}] ${v.message}`);
    }
    if (report.truncatedCount && report.truncatedCount > 0) {
      lines.push(`  ... (${report.truncatedCount} more violations truncated)`);
    }
  }

  return truncateUtf8Bytes(lines.join("\n"), MAX_SURFACE_NOTICE_BYTES);
}

export async function runChengPostWriteSurfaceGate(
  toolName: string,
  output: unknown,
  context: ToolExecutionContext,
): Promise<string | undefined> {
  const checkSurface = context.chengHostPort?.checkSurface;
  if (checkSurface === undefined) return undefined;
  const chengPaths = extractWrittenChengFilePaths(toolName, output);
  if (chengPaths.length === 0) return undefined;

  const reports = await Promise.all(chengPaths.map((filePath) => checkSurface({ filePath })));
  return formatChengSurfaceNotice(reports);
}

export function appendNoticeToModelContent(
  content: ModelMessageContent,
  notice: string,
): ModelMessageContent {
  if (typeof content === "string") {
    return content.length === 0 ? notice : `${content}\n\n${notice}`;
  }
  return [...content, { type: "text", text: notice }];
}
