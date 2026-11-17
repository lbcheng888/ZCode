import { isAbsolute, normalize, resolve } from "node:path";
import { analyzeBashCommand, type BashCommandInvocation } from "../../tool/handlers/bash-command-parser.js";
import { isSedInPlaceOption } from "../../tool/handlers/bash-readonly-policy.js";
import { canonicalizeWorkspaceFilePath } from "../../tool/path-policy.js";

export const WORKSPACE_WRITE_LEASE_REJECTED_CODE = "WORKSPACE_WRITE_LEASE_REJECTED";

export class WorkspaceWriteLeaseRejectedError extends Error {
  readonly code = WORKSPACE_WRITE_LEASE_REJECTED_CODE;
  readonly toolName: string;
  readonly targetPath?: string;

  constructor(toolName: string, message: string, targetPath?: string) {
    super(message);
    this.name = "WorkspaceWriteLeaseRejectedError";
    this.toolName = toolName;
    if (targetPath !== undefined) {
      this.targetPath = targetPath;
    }
  }
}

export interface SwarmBashGuardOptions {
  workspaceRoot: string;
  workingDirectory?: string;
  allowedWritePaths?: readonly string[];
  workspaceWriteLeaseActive?: boolean;
}

const DESTRUCTIVE_GIT_SUBCOMMANDS = new Set([
  "restore",
  "reset",
  "clean",
  "stash",
  "rebase",
]);

const WRITE_REDIRECT_OPERATORS = new Set([">", ">>", ">|", "&>", "&>>"]);
const SAFE_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

const FILE_MUTATING_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "touch",
  "mkdir",
  "chmod",
  "chown",
  "chgrp",
  "ln",
  "tee",
  "truncate",
  "dd",
]);

const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

function normalizeAllowedSet(allowedWritePaths: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const p of allowedWritePaths) {
    try {
      set.add(canonicalizeWorkspaceFilePath(p));
    } catch {
      set.add(normalize(p));
    }
  }
  return set;
}

function resolveCandidatePath(rawPath: string, baseDir: string): string {
  const abs = isAbsolute(rawPath) ? normalize(rawPath) : resolve(baseDir, rawPath);
  try {
    return canonicalizeWorkspaceFilePath(abs);
  } catch {
    return abs;
  }
}

function extractGitSubcommand(argv: readonly string[]): { subcommand?: string; args: string[] } {
  let index = 1;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (GIT_VALUE_FLAGS.has(arg)) {
      index += 2;
      continue;
    }
    if (
      arg.startsWith("-C") ||
      arg.startsWith("-c") ||
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=")
    ) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    return { subcommand: arg, args: argv.slice(index + 1) };
  }
  return { args: [] };
}

function isDestructiveGitInvocation(cmd: BashCommandInvocation): string | undefined {
  const baseName = cmd.name.split("/").pop();
  if (baseName !== "git") return undefined;
  const { subcommand, args } = extractGitSubcommand(cmd.argv);
  if (subcommand === undefined) return undefined;
  if (DESTRUCTIVE_GIT_SUBCOMMANDS.has(subcommand)) {
    return `git ${subcommand}`;
  }
  if (subcommand === "checkout" && args.includes("--")) {
    return "git checkout --";
  }
  return undefined;
}

function isCompileAdmissionMeasure(cmd: BashCommandInvocation): boolean {
  const joined = cmd.argv.join(" ");
  return (
    (joined.includes("compile_admission.sh") || cmd.name.endsWith("compile_admission.sh")) &&
    cmd.argv.includes("measure")
  );
}

function extractMutatedTargets(cmd: BashCommandInvocation): string[] {
  const baseName = cmd.name.split("/").pop() ?? cmd.name;
  if (baseName === "sed") {
    if (!cmd.argv.some(isSedInPlaceOption)) return [];
    const nonFlagArgs = cmd.argv.slice(1).filter((arg) => !arg.startsWith("-"));
    // First non-flag arg is the sed script unless -e/-f was used; last non-flag args are files.
    return nonFlagArgs.length > 1 ? nonFlagArgs.slice(1) : [];
  }

  if (!FILE_MUTATING_COMMANDS.has(baseName)) return [];

  if (baseName === "dd") {
    const targets: string[] = [];
    for (const arg of cmd.argv.slice(1)) {
      if (arg.startsWith("of=")) {
        targets.push(arg.slice(3));
      }
    }
    return targets;
  }

  const nonFlagArgs = cmd.argv.slice(1).filter((arg) => arg !== "--" && !arg.startsWith("-"));
  if (baseName === "cp" || baseName === "mv" || baseName === "ln") {
    return nonFlagArgs.length > 0 ? [nonFlagArgs[nonFlagArgs.length - 1]!] : [];
  }
  return nonFlagArgs;
}

/**
 * Deterministic Bash safety guard for AgentSwarm workers and workspace-write-leased contexts:
 * 1. Blocks `compile_admission.sh measure` (prevents MEASURE_PENDING AB-BA deadlock; guides to ChengProbeLeaf/probe).
 * 2. Blocks destructive git commands (`git checkout --`, `git restore`, `git reset`, `git clean`, `git stash`, `git rebase`).
 * 3. Blocks shell redirections and file-mutating commands targeting paths outside `allowedWritePaths` with `WorkspaceWriteLeaseRejectedError`.
 */
export function assertSwarmBashCommandSafe(
  command: string,
  options: SwarmBashGuardOptions,
): void {
  const { workspaceRoot, workingDirectory, allowedWritePaths, workspaceWriteLeaseActive } = options;
  const isActive = workspaceWriteLeaseActive === true || allowedWritePaths !== undefined;
  if (!isActive) return;

  const trimmed = command.trim();
  if (trimmed.length === 0) return;

  const baseDir = workingDirectory ?? workspaceRoot;
  const analysis = analyzeBashCommand(command);

  // Fast raw-text check as defense-in-depth when command has parse errors or dynamic words
  if (/\bcompile_admission\.sh\b[^\n;|&]*\bmeasure\b/.test(command)) {
    throw new WorkspaceWriteLeaseRejectedError(
      "Bash",
      "Blocked `compile_admission.sh measure` inside swarm/leased worker to prevent MEASURE_PENDING AB-BA deadlock. Use ChengProbeLeaf or `compile_admission.sh probe` instead.",
    );
  }
  if (
    /\bgit\s+(?:-[Cc]\s+\S+\s+)*(?:checkout\b[^\n;|&]*\s--|restore\b|reset\b|clean\b|stash\b|rebase\b)/.test(
      command,
    )
  ) {
    throw new WorkspaceWriteLeaseRejectedError(
      "Bash",
      "Blocked destructive git command inside swarm/leased worker (git checkout -- / restore / reset / clean / stash / rebase are forbidden).",
    );
  }

  for (const cmd of analysis.commands) {
    if (isCompileAdmissionMeasure(cmd)) {
      throw new WorkspaceWriteLeaseRejectedError(
        "Bash",
        "Blocked `compile_admission.sh measure` inside swarm/leased worker to prevent MEASURE_PENDING AB-BA deadlock. Use ChengProbeLeaf or `compile_admission.sh probe` instead.",
      );
    }

    const destructiveGit = isDestructiveGitInvocation(cmd);
    if (destructiveGit !== undefined) {
      throw new WorkspaceWriteLeaseRejectedError(
        "Bash",
        `Blocked destructive git command "${destructiveGit}" inside swarm/leased worker.`,
      );
    }

    if (allowedWritePaths !== undefined) {
      const allowedSet = normalizeAllowedSet(allowedWritePaths);

      for (const redirect of cmd.redirects) {
        if (!WRITE_REDIRECT_OPERATORS.has(redirect.operator)) continue;
        if (SAFE_REDIRECT_TARGETS.has(redirect.target) || redirect.target.startsWith("&")) continue;
        const resolved = resolveCandidatePath(redirect.target, baseDir);
        if (!allowedSet.has(resolved)) {
          throw new WorkspaceWriteLeaseRejectedError(
            "Bash",
            `Bash redirection "${redirect.operator} ${redirect.target}" targets "${resolved}" outside allowedWritePaths.`,
            resolved,
          );
        }
      }

      for (const target of extractMutatedTargets(cmd)) {
        const resolved = resolveCandidatePath(target, baseDir);
        if (!allowedSet.has(resolved)) {
          throw new WorkspaceWriteLeaseRejectedError(
            "Bash",
            `Bash file-mutating command "${cmd.name}" targets "${resolved}" outside allowedWritePaths.`,
            resolved,
          );
        }
      }
    }
  }
}
