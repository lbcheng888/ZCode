import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { HostError } from "./errors.js";

export function workspaceHash(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 32);
}

export function resolveWorkspaceRoot(input: string): string {
  if (input.trim().length === 0) {
    throw new HostError("host.invalidParams", "workspace root is required");
  }
  const real = realpathDirectory(input, "workspace root");
  return real;
}

/** ZCode data root; defaults to the global `~/.chengcode` root. */
export function resolveDataBaseDir(input: string | undefined): string {
  const raw = input?.trim();
  const path = raw !== undefined && raw.length > 0 ? resolve(raw) : join(homedir(), ".chengcode");
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const real = realpathSync(path);
    if (!statSync(real).isDirectory()) {
      throw new Error("not a directory");
    }
    return real;
  } catch (error) {
    throw new HostError("host.internal", `cannot prepare data base dir: ${path}`, {
      evidence: [error instanceof Error ? error.message : String(error)],
    });
  }
}

export function artifactRootFor(dataBaseDir: string, hash: string): string {
  return join(dataBaseDir, ".chengcode", "v2", "cheng", hash);
}

/**
 * Unix socket paths are capped near 104 bytes on macOS. Long data roots use a
 * short `/tmp` path keyed by uid + workspace hash; the host token still
 * authenticates the connection.
 */
export function socketPathFor(artifactRoot: string, hash: string): string {
  const candidate = join(artifactRoot, "host.sock");
  if (Buffer.byteLength(candidate, "utf8") <= 100) {
    return candidate;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `zcode-cheng-${String(uid)}-${hash}.sock`);
}

/**
 * Create the artifact root and prove it is outside the workspace. A
 * `ZCODE_DATA_BASE_DIR` pointing into the workspace must fail closed: tools
 * declaring side-effect scope `none` depend on this boundary.
 */
export function ensureArtifactRoot(root: string, workspaceRoot: string): string {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const real = realpathSync(root);
    if (!statSync(real).isDirectory()) {
      throw new Error("not a directory");
    }
    assertOutsideWorkspace(real, workspaceRoot);
    return real;
  } catch (error) {
    if (error instanceof HostError) {
      throw error;
    }
    throw new HostError("host.internal", `cannot prepare artifact root: ${root}`, {
      evidence: [error instanceof Error ? error.message : String(error)],
    });
  }
}

export function assertOutsideWorkspace(path: string, workspaceRoot: string): void {
  if (isWithin(workspaceRoot, path)) {
    throw new HostError(
      "host.artifactRootInsideWorkspace",
      "artifact root must not be inside the workspace",
      { evidence: [`artifact=${path}`, `workspace=${workspaceRoot}`] },
    );
  }
}

/**
 * Resolve a request-supplied path and require it under one of the trusted
 * roots. `realpath` runs first, so `..` and symlink escapes cannot pass.
 */
export function resolveAllowedPath(
  candidate: string,
  roots: readonly string[],
  options: { kind: "file" | "directory"; code: "host.specRootNotAllowed" },
): string {
  let real: string;
  try {
    real = realpathSync(resolve(candidate));
  } catch (error) {
    throw new HostError(options.code, `path does not exist: ${candidate}`, {
      evidence: [error instanceof Error ? error.message : String(error)],
    });
  }
  const stat = statSync(real);
  if (options.kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
    throw new HostError(options.code, `path is not a ${options.kind}: ${candidate}`, {
      evidence: [`realpath=${real}`],
    });
  }
  if (!roots.some((root) => isWithin(root, real))) {
    throw new HostError(options.code, `path is outside the allowed roots: ${candidate}`, {
      evidence: [`realpath=${real}`, ...roots.map((root) => `allowed=${root}`)],
    });
  }
  return real;
}

export function realpathDirectory(input: string, label: string): string {
  try {
    const real = realpathSync(resolve(input));
    if (!statSync(real).isDirectory()) {
      throw new Error("not a directory");
    }
    return real;
  } catch (error) {
    throw new HostError("host.invalidParams", `${label} is not a directory: ${input}`, {
      evidence: [error instanceof Error ? error.message : String(error)],
    });
  }
}

/** True when `child` is `parent` itself or below it on a path boundary. */
export function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}
