import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("createServerHostServices 把端口装配进 botsService：bot 回调进入 trigger.ingest 并跳过 legacy（§4.2）", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-server-host-sink-"));
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("packages/services/test/helpers/serverHostServicesTriggerSinkFixture.ts"),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: home },
        timeout: 30_000,
      },
    );
    expect(result.stdout).toContain("TRIGGER_SINK_ASSEMBLY_VERIFIED");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 35_000);
