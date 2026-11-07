/**
 * 隐藏子命令 `__zcode-cheng-host`：cheng-host 的打包入口。
 *
 * 钉住两件事：
 *   1. 只认 argv[0]，避免普通 prompt 提到该词就改变 CLI 行为；
 *   2. 分派发生在 parseArgs 之前，且运行时探针失败按 host 口径返回 78。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { CHENG_HOST_COMMAND } from "@zcode/contracts";
import type { RunContext } from "@zcode/shared-types";

import { isChengHostInvocation } from "../src/cheng-host-command.js";
import { run } from "../src/run.js";

const captured = () => {
  let output = "";
  return {
    output: () => output,
    stream: {
      isTTY: false,
      write: (chunk: string | Uint8Array): boolean => {
        output += typeof chunk === "string" ? chunk : chunk.toString();
        return true;
      },
    } as unknown as NodeJS.WriteStream,
  };
};

const context = (argv: string[]): { ctx: RunContext; stderr: () => string } => {
  const stderr = captured();
  return {
    ctx: {
      argv,
      stderr: stderr.stream,
      stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
      stdout: captured().stream,
    },
    stderr: stderr.output,
  };
};

test("recognises the cheng host subcommand only as argv[0]", () => {
  assert.equal(isChengHostInvocation([CHENG_HOST_COMMAND, "--scope=stdio"]), true);
  assert.equal(isChengHostInvocation([]), false);
  assert.equal(isChengHostInvocation(["--help"]), false);
  assert.equal(isChengHostInvocation(["-p", CHENG_HOST_COMMAND]), false);
});

test("fails with the host's usage error before strict CLI parsing", async () => {
  const { ctx, stderr } = context([CHENG_HOST_COMMAND]);
  const exitCode = await run(ctx);
  assert.equal(exitCode, 1);
  assert.match(stderr(), /Cheng host failed/);
  assert.match(stderr(), /--scope=stdio\|workspace is required/);
});

test("maps a runtime probe failure to exit 78", async () => {
  const previous = process.env.ZCODE_CHENG_ROOT;
  delete process.env.ZCODE_CHENG_ROOT;
  try {
    const dataBaseDir = mkdtempSync(join(tmpdir(), "cheng-cli-entry-"));
    const { ctx, stderr } = context([
      CHENG_HOST_COMMAND,
      "--scope=stdio",
      "--workspace-root=/tmp/ws",
      `--data-base-dir=${dataBaseDir}`,
    ]);
    const exitCode = await run(ctx);
    assert.equal(exitCode, 78);
    assert.match(stderr(), /host\.runtimeUnavailable/);
    assert.match(stderr(), /ZCODE_CHENG_ROOT is not set/);
  } finally {
    if (previous === undefined) delete process.env.ZCODE_CHENG_ROOT;
    else process.env.ZCODE_CHENG_ROOT = previous;
  }
});
