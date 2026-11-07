import { describe, expect, it } from "vitest";

import { StdioHostClient } from "../src/client.js";

describe("StdioHostClient", () => {
  it("fails closed when the host process stays alive but never answers the handshake", async () => {
    const startedAt = Date.now();
    await expect(
      StdioHostClient.connect({
        command: "/bin/sleep",
        args: ["5"],
        cwd: "/tmp",
        env: process.env,
        workspaceRoot: "/tmp",
        workspaceIdentity: "test-workspace",
        startupTimeoutMs: 200,
      }),
    ).rejects.toMatchObject({ code: "host.responseTimeout" });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
