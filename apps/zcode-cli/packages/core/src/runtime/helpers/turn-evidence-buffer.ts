import { createHash } from "node:crypto";

export const DEFAULT_TURN_EVIDENCE_MAX_ENTRIES = 16;
export const DEFAULT_TURN_EVIDENCE_MAX_BYTES = 12 * 1024;

export interface TurnEvidenceEntry {
  toolCallId: string;
  toolName: string;
  targetFiles: string[];
  digest: string;
  recordedAtMs?: number;
}

export interface TurnEvidenceBufferOptions {
  maxEntries?: number;
  maxBytes?: number;
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(text) <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  let end = Math.min(buf.length, maxBytes);
  // Avoid splitting a multi-byte UTF-8 character at the boundary
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

/**
 * Bounded per-turn ring buffer capturing read-only tool call summaries
 * (`maxEntries = 16`, `maxBytes = 12 KiB`) for Two-Phase Grounded BestPlan.
 */
export class TurnEvidenceBuffer {
  readonly maxEntries: number;
  readonly maxBytes: number;
  private readonly buffer: TurnEvidenceEntry[] = [];
  private readonly entryBytes: number[] = [];
  private currentBytes = 0;

  constructor(options?: TurnEvidenceBufferOptions) {
    this.maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_TURN_EVIDENCE_MAX_ENTRIES);
    this.maxBytes = Math.max(128, options?.maxBytes ?? DEFAULT_TURN_EVIDENCE_MAX_BYTES);
  }

  record(input: TurnEvidenceEntry): void {
    const normalized: TurnEvidenceEntry = {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      targetFiles: [...input.targetFiles],
      digest: input.digest,
      ...(input.recordedAtMs === undefined ? {} : { recordedAtMs: input.recordedAtMs }),
    };

    let serializedBytes = utf8ByteLength(JSON.stringify(normalized));
    if (serializedBytes > this.maxBytes) {
      const overheadBytes = utf8ByteLength(
        JSON.stringify({ ...normalized, digest: "" }),
      );
      const allowedDigestBytes = Math.max(0, this.maxBytes - overheadBytes);
      normalized.digest = truncateToUtf8Bytes(normalized.digest, allowedDigestBytes);
      serializedBytes = utf8ByteLength(JSON.stringify(normalized));
      if (serializedBytes > this.maxBytes) {
        normalized.targetFiles = [];
        normalized.digest = truncateToUtf8Bytes(
          normalized.digest,
          Math.max(0, this.maxBytes - utf8ByteLength(JSON.stringify({ ...normalized, digest: "" }))),
        );
        serializedBytes = utf8ByteLength(JSON.stringify(normalized));
      }
    }

    this.buffer.push(normalized);
    this.entryBytes.push(serializedBytes);
    this.currentBytes += serializedBytes;

    while (
      this.buffer.length > this.maxEntries ||
      (this.currentBytes > this.maxBytes && this.buffer.length > 1)
    ) {
      this.buffer.shift();
      const removedBytes = this.entryBytes.shift() ?? 0;
      this.currentBytes -= removedBytes;
    }
  }

  entries(): readonly TurnEvidenceEntry[] {
    return this.buffer;
  }

  get length(): number {
    return this.buffer.length;
  }

  get byteLength(): number {
    return this.currentBytes;
  }

  getDigest(): string {
    return createHash("sha256")
      .update(JSON.stringify(this.buffer))
      .digest("hex");
  }

  clear(): void {
    this.buffer.length = 0;
    this.entryBytes.length = 0;
    this.currentBytes = 0;
  }
}
