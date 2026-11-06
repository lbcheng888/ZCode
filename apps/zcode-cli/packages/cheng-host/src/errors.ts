import { z } from "zod";

/**
 * Host-level failures only. Cheng pipeline exit codes stay in ChengError and
 * are never invented here; a host error is a transport/lifecycle fact, not a
 * verdict about a run.
 */
export const HOST_ERROR_CODES = [
  "host.authFailed",
  "host.capabilitiesRequired",
  "host.capabilitiesMismatch",
  "host.duplicateRequestId",
  "host.invalidParams",
  "host.invalidResult",
  "host.resultTooLarge",
  "host.protocol",
  "host.unsupportedMethod",
  "host.opUnavailable",
  "host.runtimeUnavailable",
  "host.platformUnsupported",
  "host.specRootNotAllowed",
  "host.artifactRootInsideWorkspace",
  "host.busy",
  "host.spawnBusy",
  "host.jobNotFound",
  "host.jobNotSucceeded",
  "host.cancelUnconfirmed",
  "host.processTreeLeaked",
  "host.hostRestarted",
  "host.unexpectedExit",
  "host.unknownRunnerExit",
  "host.runVolumeMissing",
  "host.verifyUnavailable",
  "host.responseTimeout",
  "host.shutdown",
  "host.internal",
] as const;

export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];

export const HostErrorPayloadSchema = z
  .object({
    code: z.enum(HOST_ERROR_CODES),
    message: z.string().min(1),
    retriable: z.boolean(),
    evidence: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export type HostErrorPayload = z.infer<typeof HostErrorPayloadSchema>;

const RETRIABLE: ReadonlySet<HostErrorCode> = new Set(["host.busy", "host.spawnBusy"]);

export class HostError extends Error {
  readonly code: HostErrorCode;
  readonly retriable: boolean;
  readonly evidence: readonly string[] | undefined;

  constructor(code: HostErrorCode, message: string, options: { evidence?: readonly string[] } = {}) {
    super(message);
    this.name = "HostError";
    this.code = code;
    this.retriable = RETRIABLE.has(code);
    this.evidence = options.evidence;
  }

  toPayload(): HostErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      ...(this.evidence === undefined ? {} : { evidence: [...this.evidence] }),
    };
  }
}

export function isHostError(value: unknown): value is HostError {
  return value instanceof HostError;
}

/**
 * Convert any thrown value into a typed host error. Unknown errors become
 * `host.internal` with the original message; stacks never cross the wire.
 */
export function toHostError(value: unknown): HostError {
  if (isHostError(value)) {
    return value;
  }
  const message = value instanceof Error ? value.message : String(value);
  return new HostError("host.internal", message.length > 0 ? message : "unknown host failure");
}
