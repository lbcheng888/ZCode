import { createHash } from "node:crypto";

import type { RuntimePin } from "./runtime.js";
import { canonicalJson } from "./canonical.js";
import { METHOD_SCHEMAS, type Capabilities, CapabilitiesSchema } from "./protocol.js";
import { CONTRACT_MAJOR, HOST_VERSION, PROTOCOL_VERSION } from "./version.js";

/**
 * Capabilities are computed from the frozen method table and the probed
 * runtime. The fingerprint covers both; a client that sees a different
 * fingerprint for the same contract major refuses to call (no downgrade).
 */
export function buildCapabilities(pin: RuntimePin): Capabilities {
  const ops = Object.fromEntries(
    Object.entries(METHOD_SCHEMAS).map(([name, schema]) => [
      name,
      {
        available: schema.available,
        sync: schema.sync,
        cancellable: schema.cancellable,
      },
    ]),
  );
  const body = {
    protocolVersion: PROTOCOL_VERSION,
    contractMajor: CONTRACT_MAJOR,
    hostVersion: HOST_VERSION,
    runtime: {
      chengRoot: pin.chengRoot,
      headSha: pin.headSha,
      runnerSha256: pin.runnerSha256,
      driverSha256: pin.driverSha256,
      gitWorkTree: true,
    },
    ops,
  };
  const fingerprint = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return CapabilitiesSchema.parse({ ...body, fingerprint });
}
