/**
 * Swarm worker 的 git worktree 隔离与合并闸门。
 *
 * 每个 worker 一个 `git worktree add --detach <head>` 工作树：
 * - 创建：`git worktree add` 串行调用（.git/worktrees 元数据互斥），workingDirectory /
 *   workspaceRoot 映射到工作树内同一相对位置；
 * - 回写：工作树内 `git add -A` + 内部 commit，`git merge-tree --write-tree`
 *   对当前基准 HEAD 预检冲突，干净才 `git merge --no-ff`；
 * - 清理：`git worktree remove --force` + 删除临时根目录。
 * 所有 git 进程错误原样上浮（非零退出码带 stderr），不做原地重试或降级到共享目录。
 */

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { CoreErrorType, createCoreError } from "@zcode/contracts";

import type {
  SwarmWorkspace,
  SwarmWorkspaceFactory,
  SwarmWorkspaceRequest,
} from "./swarm-types.js";

const SWARM_TEMP_PREFIX = "zcode-swarm-";
/** 临时根里的 owner 文件记录创建者 pid；恢复器据此跳过仍在运行的另一轮。 */
const SWARM_OWNER_FILE = "owner";

export class GitWorktreeSwarmWorkspaceFactory implements SwarmWorkspaceFactory {
  async create(request: SwarmWorkspaceRequest): Promise<SwarmWorkspace> {
    const repoRoot = await realpath(
      await git(["rev-parse", "--show-toplevel"], request.baseWorkingDirectory),
    );
    const baseHead = await git(["rev-parse", "HEAD"], repoRoot);
    const workingRelative = await repoRelativePath(repoRoot, request.baseWorkingDirectory);
    const workspaceRelative = await repoRelativePath(repoRoot, request.baseWorkspaceRoot);
    const tempRoot = await mkdtemp(
      join(
        tmpdir(),
        `${SWARM_TEMP_PREFIX}${sanitizePathSegment(request.roundId)}-${sanitizePathSegment(request.taskId)}-`,
      ),
    );
    const worktreePath = join(tempRoot, "worktree");
    try {
      await writeFile(join(tempRoot, SWARM_OWNER_FILE), `${process.pid}\n`, "utf8");
      await git(["worktree", "add", "--detach", worktreePath, baseHead], repoRoot);
    } catch (error) {
      // 建树失败要清掉已创建的临时根；清理失败不覆盖原始 git 错误。
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return new GitWorktreeSwarmWorkspace({
      repoRoot,
      tempRoot,
      worktreePath,
      roundId: request.roundId,
      taskId: request.taskId,
      workingDirectory: join(worktreePath, workingRelative),
      workspaceRoot: join(worktreePath, workspaceRelative),
    });
  }
}

/** runGoalRound 启动前的 git 前置条件：仓库、已有提交、干净状态、目录都在仓库内。 */
export interface SwarmGitPreconditions {
  baseWorkingDirectory: string;
  baseWorkspaceRoot: string;
}

/**
 * 启动期 fail-closed：任一前置条件不满足都抛 ConfigurationError(recoverable:false)，
 * 绝不把一轮蜂群放进非仓库/无提交/脏基准树。返回仓库根供孤儿工作树恢复使用。
 */
export async function assertSwarmGitPreconditions(
  input: SwarmGitPreconditions,
): Promise<string> {
  try {
    const repoRoot = await realpath(
      await git(["rev-parse", "--show-toplevel"], input.baseWorkingDirectory),
    );
    // 无提交的仓库没有可建工作树的基准 HEAD；verify 失败即为确定性前置错误。
    await git(["rev-parse", "--verify", "HEAD^{commit}"], repoRoot);
    const status = await git(["status", "--porcelain"], repoRoot);
    if (status) {
      throw new Error(`git status --porcelain is not empty in ${repoRoot}:\n${status}`);
    }
    await repoRelativePath(repoRoot, input.baseWorkingDirectory);
    await repoRelativePath(repoRoot, input.baseWorkspaceRoot);
    return repoRoot;
  } catch (error) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `Swarm git preconditions failed: ${errorMessage(error)}`,
      {
        ...(error instanceof Error ? { cause: error } : {}),
        recoverable: false,
      },
    );
  }
}

/**
 * 合并闸门通过后的清洁复核：闸门与 merge 之间基准树可能被并发写脏，脏树上 merge
 * 会把 worker 的提交和未提交 WIP 搅在一起，因此必须在第一次 merge 前重新检查。
 */
export async function assertSwarmBaseClean(directory: string): Promise<void> {
  const repoRoot = await realpath(await git(["rev-parse", "--show-toplevel"], directory));
  const status = await git(["status", "--porcelain"], repoRoot);
  if (status) {
    throw new Error(`Swarm base worktree ${repoRoot} is not clean:\n${status}`);
  }
}

/** 孤儿工作树恢复结果；清理失败只记录，由调用方写日志，不阻塞本轮。 */
export interface SwarmOrphanRecovery {
  removed: readonly string[];
  failures: readonly { path: string; error: string }[];
  /** 临时目录整体不可读（缺失/无权限）；读取失败不得中止本轮，只由调用方记 warn。 */
  error?: string;
}

/**
 * 清理 /tmp/zcode-swarm-* 下上一进程遗留的工作树与临时目录。
 * owner 文件记录的 pid 仍存活时跳过——同一仓库可能有多轮蜂群并发运行，不能误删
 * 别人的活动工作树；pid 已退出（或没有 owner 文件）才按孤儿处理。清理完成后
 * worktree prune 收口 .git/worktrees 元数据。
 */
export async function recoverOrphanedSwarmWorktrees(
  repoRoot: string,
): Promise<SwarmOrphanRecovery> {
  const removed: string[] = [];
  const failures: Array<{ path: string; error: string }> = [];
  let entries: Dirent[];
  try {
    entries = await readdir(tmpdir(), { withFileTypes: true });
  } catch (error) {
    // 临时目录缺失/无权限属于恢复面故障：返回给调用方记 warn，round 继续。
    return { removed, failures, error: errorMessage(error) };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SWARM_TEMP_PREFIX)) continue;
    const tempRoot = join(tmpdir(), entry.name);
    // 同前缀但本身是 git 仓库的目录（例如测试夹具）不是蜂群临时根，不能删。
    if (await pathExists(join(tempRoot, ".git"))) continue;
    // 只认本工厂产出的目录形态：owner 文件在 mkdtemp 后立即写入，worktree 随后创建。
    // 同前缀但两者都没有的目录属于别的工具/测试（可能正处于 mkdtemp→git init 的窗口），
    // 绝不能因为前缀相同就 rm；否则并发轮次会删掉别人正在初始化的临时仓库。
    if (
      !(await pathExists(join(tempRoot, SWARM_OWNER_FILE))) &&
      !(await pathExists(join(tempRoot, "worktree")))
    ) {
      continue;
    }
    const hasWorktree = await pathExists(join(tempRoot, "worktree"));
    if (await isLiveSwarmTempRoot(tempRoot)) continue;
    try {
      const worktreePath = join(tempRoot, "worktree");
      if (hasWorktree) {
        // 目录存在但进程已死：先让 git 移除注册元数据；未注册时 git 会报错，
        // 随后 rm 仍能清掉残留目录，最终由 worktree prune 收口。
        try {
          await runGit(["worktree", "remove", "--force", worktreePath], repoRoot);
        } catch {
          // 未注册的工作树目录不影响临时目录删除；prune 会清掉元数据。
        }
      }
      await rm(tempRoot, { recursive: true, force: true });
      removed.push(entry.name);
    } catch (error) {
      failures.push({ path: tempRoot, error: errorMessage(error) });
    }
  }
  if (removed.length > 0) {
    try {
      const prune = await runGit(["worktree", "prune"], repoRoot);
      if (prune.exitCode !== 0) {
        failures.push({
          path: repoRoot,
          error: `git worktree prune failed (exit ${prune.exitCode}): ${
            prune.stderr.trim() || prune.stdout.trim()
          }`,
        });
      }
    } catch (error) {
      failures.push({ path: repoRoot, error: errorMessage(error) });
    }
  }
  return { removed, failures };
}

interface GitWorktreeSwarmWorkspaceOptions {
  repoRoot: string;
  tempRoot: string;
  worktreePath: string;
  roundId: string;
  taskId: string;
  workingDirectory: string;
  workspaceRoot: string;
}

class GitWorktreeSwarmWorkspace implements SwarmWorkspace {
  readonly workingDirectory: string;
  readonly workspaceRoot: string;
  private readonly repoRoot: string;
  private readonly tempRoot: string;
  private readonly worktreePath: string;
  private readonly roundId: string;
  private readonly taskId: string;

  constructor(options: GitWorktreeSwarmWorkspaceOptions) {
    this.repoRoot = options.repoRoot;
    this.tempRoot = options.tempRoot;
    this.worktreePath = options.worktreePath;
    this.roundId = options.roundId;
    this.taskId = options.taskId;
    this.workingDirectory = options.workingDirectory;
    this.workspaceRoot = options.workspaceRoot;
  }

  async merge(): Promise<void> {
    await git(["add", "-A", "--", "."], this.worktreePath);
    const staged = await runGit(["diff", "--cached", "--quiet", "--exit-code"], this.worktreePath);
    if (staged.exitCode === 1) {
      await git(
        [
          "-c",
          "user.name=ZCode Swarm",
          "-c",
          "user.email=swarm@zcode.local",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--no-verify",
          "-m",
          `swarm(${this.roundId}): ${this.taskId}`,
        ],
        this.worktreePath,
      );
    } else if (staged.exitCode !== 0) {
      throw new Error(
        `git diff --cached failed in swarm worktree ${this.taskId} (exit ${staged.exitCode}): ${
          staged.stderr.trim() || staged.stdout.trim()
        }`,
      );
    }

    const workerHead = await git(["rev-parse", "HEAD"], this.worktreePath);
    const baseHead = await git(["rev-parse", "HEAD"], this.repoRoot);
    if (workerHead === baseHead) return;

    // 纯预检：--write-tree 只写对象库，不碰基准工作树/index。
    const mergeTree = await runGit(
      ["merge-tree", "--write-tree", baseHead, workerHead],
      this.repoRoot,
    );
    if (mergeTree.exitCode === 1) {
      throw new Error(
        `Swarm merge conflict for task ${this.taskId}:\n${
          mergeTree.stdout.trim() || mergeTree.stderr.trim()
        }`,
      );
    }
    if (mergeTree.exitCode !== 0) {
      throw new Error(
        `git merge-tree failed for swarm task ${this.taskId} (exit ${mergeTree.exitCode}): ${
          mergeTree.stderr.trim() || mergeTree.stdout.trim()
        }`,
      );
    }

    try {
      await git(
        [
          "-c",
          "user.name=ZCode Swarm",
          "-c",
          "user.email=swarm@zcode.local",
          "-c",
          "commit.gpgsign=false",
          "merge",
          "--no-ff",
          "--no-edit",
          // 与 worker commit 一致：commit-msg / pre-merge-commit hook 不得让基准
          // merge 停在半完成状态。
          "--no-verify",
          "-m",
          `swarm(${this.roundId}): merge ${this.taskId}`,
          workerHead,
        ],
        this.repoRoot,
      );
    } catch (error) {
      await abortMergeIfInProgress(this.repoRoot, error);
    }
  }

  async dispose(): Promise<void> {
    await git(["worktree", "remove", "--force", this.worktreePath], this.repoRoot);
    await rm(this.tempRoot, { recursive: true, force: true });
  }
}

/**
 * merge 失败后的基准树收口：冲突与 hook 拒绝都可能留下 MERGE_HEAD，下一次 merge
 * 与下一轮 preflight 会全部失败。先 `git merge --abort` 回到 merge 前状态，再把
 * 原始错误原样抛回；abort 自身失败时把其错误附在消息里，绝不吞掉。
 */
async function abortMergeIfInProgress(repoRoot: string, originalError: unknown): Promise<never> {
  let mergeInProgress = false;
  try {
    mergeInProgress =
      (await runGit(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], repoRoot)).exitCode === 0;
  } catch {
    // git 进程无法启动时 merge 不可能留下 MERGE_HEAD；原始错误照常上浮。
  }
  if (!mergeInProgress) throw originalError;
  try {
    await git(["merge", "--abort"], repoRoot);
  } catch (abortError) {
    throw new Error(
      `${errorMessage(originalError)}\nAdditionally, git merge --abort failed: ${errorMessage(abortError)}`,
      originalError instanceof Error ? { cause: originalError } : undefined,
    );
  }
  throw originalError;
}

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 跑 git 并把非零退出码作为数据返回；只有进程无法启动（ENOENT 等）才 reject。 */
function runGit(args: readonly string[], cwd: string): Promise<GitCommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (typeof code !== "number") {
            reject(error);
            return;
          }
          resolvePromise({ exitCode: code, stdout, stderr });
          return;
        }
        resolvePromise({ exitCode: 0, stdout, stderr });
      },
    );
  });
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with exit code ${result.exitCode}: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  return result.stdout.trim();
}

/** 把调用方目录映射为相对仓库根的路径；仓库外的目录无法被工作树隔离，直接拒绝。 */
async function repoRelativePath(repoRoot: string, path: string): Promise<string> {
  // macOS 的 /tmp 是 /private/tmp 的符号链接：git 返回 canonical path，调用方
  // 目录却可能带符号链接前缀。先 realpath 再比较，否则同一目录会被误判成仓库外。
  const relativePath = relative(repoRoot, await realpath(resolve(path)));
  if (relativePath.startsWith("..") || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Swarm workspace path ${path} is outside git repository ${repoRoot}`);
  }
  return relativePath;
}

async function isLiveSwarmTempRoot(tempRoot: string): Promise<boolean> {
  try {
    const raw = await readFile(join(tempRoot, SWARM_OWNER_FILE), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // ESRCH = 进程已退出；EPERM = 进程存在但属于其他用户，同样不能删。
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
