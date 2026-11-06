import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HostError } from "../src/errors.js";
import {
  artifactRootFor,
  assertOutsideWorkspace,
  ensureArtifactRoot,
  isWithin,
  resolveAllowedPath,
  workspaceHash,
} from "../src/paths.js";
import { realpathSync } from "node:fs";
import { tempDir } from "./helpers.js";

describe("paths and allowlists", () => {
  it("refuses an artifact root inside the workspace", () => {
    const workspace = tempDir("ws-");
    const inside = join(workspace, "artifacts");
    expect(() => ensureArtifactRoot(inside, workspace)).toThrow(HostError);
    try {
      ensureArtifactRoot(inside, workspace);
    } catch (error) {
      expect(error).toMatchObject({ code: "host.artifactRootInsideWorkspace" });
    }
  });

  it("accepts an artifact root outside the workspace", () => {
    const workspace = tempDir("ws-");
    const outside = join(tempDir("data-"), "cheng");
    const real = ensureArtifactRoot(outside, workspace);
    expect(real).toBe(realpathSync(outside));
    expect(isWithin(workspace, real)).toBe(false);
  });

  it("rejects paths outside the allowed roots", () => {
    const root = tempDir("root-");
    const outside = join(tempDir("outside-"), "spec.json");
    writeFileSync(outside, "{}\n");
    expect(() =>
      resolveAllowedPath(outside, [root], { kind: "file", code: "host.specRootNotAllowed" }),
    ).toThrow(HostError);
  });

  it("resolves symlink escapes and rejects them", () => {
    const root = tempDir("root-");
    const outside = join(tempDir("outside-"), "target.json");
    writeFileSync(outside, "{}\n");
    const link = join(root, "spec.json");
    symlinkSync(outside, link);
    expect(() =>
      resolveAllowedPath(link, [root], { kind: "file", code: "host.specRootNotAllowed" }),
    ).toThrow(HostError);
  });

  it("accepts a file under the root and hashes the workspace deterministically", () => {
    const root = tempDir("root-");
    const spec = join(root, "spec.json");
    writeFileSync(spec, "{}\n");
    expect(resolveAllowedPath(spec, [root], { kind: "file", code: "host.specRootNotAllowed" })).toBe(
      realpathSync(spec),
    );
    expect(workspaceHash(root)).toBe(workspaceHash(root));
    expect(workspaceHash(root)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps artifactRootFor under the global data root", () => {
    const data = tempDir("data-");
    const root = artifactRootFor(data, "a".repeat(32));
    expect(isWithin(data, root)).toBe(true);
    expect(() => assertOutsideWorkspace(root, data)).toThrow(HostError);
  });

  it("rejects a nested workspace as a prefix trick", () => {
    const workspace = tempDir("ws-");
    const sibling = `${workspace}-evil`;
    mkdirSync(sibling, { recursive: true });
    expect(isWithin(workspace, sibling)).toBe(false);
  });
});
