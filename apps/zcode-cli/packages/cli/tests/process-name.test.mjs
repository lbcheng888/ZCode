import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = resolve(import.meta.dirname, "../dist/zcode.cjs");
const packageJsonPath = resolve(import.meta.dirname, "../package.json");

test("exposes chengcode as the primary command and keeps zcode as a compatibility alias", async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  assert.deepEqual(packageJson.bin, {
    chengcode: "./dist/zcode.cjs",
    zcode: "./dist/zcode.cjs",
  });
});

test("sets the visible process name before running commands", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, "doctor", "--json"]);
  const payload = JSON.parse(stdout);

  assert.equal(payload.cli.name, "zcode");
  assert.equal(payload.cli.processName, "zcode-cli");
  assert.equal(payload.runtime.processTitle, "zcode-cli");
});
