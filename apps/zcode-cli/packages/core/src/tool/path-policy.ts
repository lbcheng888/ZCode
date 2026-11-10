// ============================================================
// Tool Path Policy
// ============================================================

import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize, parse, resolve, sep } from "node:path";
import { CoreErrorType, createCoreError, isCoreError } from "@zcode/contracts";

interface ToolWorkspacePathOptions {
  inputPath: string;
  workingDirectory: string;
  workspaceRoot: string;
  /**
   * swarm worker 的强制工作区边界（绝对路径，必须存在）。在场时所有路径先做 realpath
   * 规范化再判定是否位于边界内；缺席 = 普通会话，保持既有的“不硬拦 workspaceRoot 外路径”语义。
   * 边界只约束文件工具与显式 cwd；Bash 命令字符串内部的 `cd /绝对路径` 仍可能离开边界，
   * 命令字符串级隔离不在本层做启发式拦截。
   */
  workspaceBoundary?: string;
  /**
   * 文件域 lane 的写白名单（绝对路径）。只由 Write/Edit/ApplyPatch 传入；读工具不传。
   * 目标路径按 realpath 收敛后必须与白名单中的某个文件完全一致，否则 fail-closed。
   */
  allowedWritePaths?: readonly string[];
  operation: "read" | "write" | "execute";
}

/** 把绝对路径按工具同一套 realpath 规则收敛（含 dangling 尾段与符号链接）。 */
export function canonicalizeWorkspaceFilePath(absolutePath: string): string {
  return canonicalizePath(normalize(absolutePath));
}

export function resolveWorkspacePath(options: ToolWorkspacePathOptions): string {
  const workingDirectory = normalizeAbsoluteDirectory(
    options.workingDirectory,
    "workingDirectory",
  );
  normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
  const requestedPath = options.inputPath;

  if (requestedPath.length === 0) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Tool path must not be empty", {
      context: {
        operation: options.operation,
      },
      recoverable: true,
    });
  }

  const resolvedPath = isAbsolute(requestedPath)
    ? normalize(requestedPath)
    : resolve(workingDirectory, requestedPath);

  if (options.workspaceBoundary === undefined && options.allowedWritePaths === undefined) {
    // Current release intentionally does not hard-block paths outside workspaceRoot.
    // Cause: subagents may need to inspect user-requested sibling repos or external files
    // before the filesystem permission adapter grows explicit ask/deny rules for them.
    return resolvedPath;
  }

  const boundary =
    options.workspaceBoundary === undefined
      ? undefined
      : resolveWorkspaceBoundary(options.workspaceBoundary);
  // 返回规范化后的路径：校验的是 realpath 结果，交给 FileSystemPort 的必须是同一份字节，
  // 否则校验与打开可能被同一棵目录树里的符号链接分化成两个目标。
  const canonicalPath = canonicalizePath(resolvedPath);
  if (boundary !== undefined && !isPathWithinBoundary(canonicalPath, boundary)) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Tool path escapes the workspace boundary: path=${canonicalPath}, boundary=${boundary}`,
      {
        context: {
          boundary,
          operation: options.operation,
          path: canonicalPath,
        },
        recoverable: true,
      },
    );
  }
  if (options.allowedWritePaths !== undefined) {
    const allowed = resolveAllowedWritePathSet(options.allowedWritePaths, options.workspaceRoot);
    if (!allowed.has(canonicalPath)) {
      const listed = [...allowed].slice(0, AGENT_SWARM_MAX_ERROR_ALLOWED_PATHS);
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `Tool path is outside the AgentSwarm file domain: path=${canonicalPath}, allowedCount=${allowed.size}`,
        {
          context: {
            operation: options.operation,
            path: canonicalPath,
            allowedWritePaths: listed,
            allowedWritePathCount: allowed.size,
          },
          recoverable: true,
        },
      );
    }
  }
  return canonicalPath;
}

/** 错误里最多列出的白名单条数；完整列表可能很长，不塞进 tool result。 */
const AGENT_SWARM_MAX_ERROR_ALLOWED_PATHS = 4;

/**
 * 白名单与目标同一套 realpath 语义：相对项按 workspaceRoot 解析，符号链接收敛后再比较。
 * 白名单本身逃出 workspaceRoot 时 fail-closed，不能把 linked out 的路径当成合法写域。
 */
function resolveAllowedWritePathSet(
  allowedWritePaths: readonly string[],
  workspaceRoot: string,
): Set<string> {
  const root = canonicalizePath(normalizeAbsoluteDirectory(workspaceRoot, "workspaceRoot"));
  const allowed = new Set<string>();
  for (const entry of allowedWritePaths) {
    const absolute = isAbsolute(entry) ? normalize(entry) : resolve(root, entry);
    const canonical = canonicalizePath(absolute);
    if (!isPathWithinBoundary(canonical, root)) {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        `AgentSwarm allowedWritePaths entry escapes workspaceRoot: path=${canonical}, workspaceRoot=${root}`,
        {
          context: {
            path: canonical,
            workspaceRoot: root,
          },
          recoverable: false,
        },
      );
    }
    allowed.add(canonical);
  }
  return allowed;
}

export function resolveToolWorkingDirectory(
  inputCwd: string | undefined,
  options: Omit<ToolWorkspacePathOptions, "inputPath">,
): string {
  if (!inputCwd) {
    // boundary 在场时 cwd 本身也必须落在狱内；普通会话保持原有的“只归一化”语义。
    if (options.workspaceBoundary !== undefined) {
      return resolveWorkspacePath({
        ...options,
        inputPath: options.workingDirectory,
      });
    }
    const workingDirectory = normalizeAbsoluteDirectory(
      options.workingDirectory,
      "workingDirectory",
    );
    normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
    return workingDirectory;
  }

  return resolveWorkspacePath({
    ...options,
    inputPath: inputCwd,
  });
}

/**
 * 边界是 fail-closed 的配置事实：空串、相对路径或不存在的目录都不能被解释成“没有边界”。
 * 不存在会让 realpath 无从判定祖先链，因此按 ConfigurationError 停住，而不是放行请求路径。
 */
function resolveWorkspaceBoundary(value: string): string {
  if (value.trim().length === 0 || !isAbsolute(value)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "workspaceBoundary must be an absolute path for tool execution",
      {
        context: {
          workspaceBoundary: value,
        },
        recoverable: false,
      },
    );
  }
  try {
    const canonical = realpathSync(normalize(value));
    if (!statSync(canonical).isDirectory()) {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "workspaceBoundary must be an existing directory for tool execution",
        {
          context: {
            workspaceBoundary: value,
          },
          recoverable: false,
        },
      );
    }
    return canonical;
  } catch (error) {
    if (isCoreError(error)) throw error;
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "workspaceBoundary must be an existing directory for tool execution",
      {
        cause: error instanceof Error ? error : undefined,
        context: {
          workspaceBoundary: value,
        },
        recoverable: false,
      },
    );
  }
}

const MAX_SYMLINK_RESOLUTIONS = 40;

/**
 * realpath 规范化必须逐段解析 symlink，包括 dangling link：不存在的尾段按“最近存在祖先
 * 的规范化路径 + 剩余段”拼接，但 symlink 本身不能被当成“不存在的尾段”拼回去，否则校验
 * 通过后写入会顺着链接落到边界外。readlink 目标相对 symlink 父目录解析；循环或超过
 * 解析上限一律 fail-closed，不猜最终目标。
 */
function canonicalizePath(absolutePath: string): string {
  return resolveSymlinkChain(normalize(absolutePath), 0, new Set());
}

function resolveSymlinkChain(
  absolutePath: string,
  depth: number,
  visitedLinks: Set<string>,
): string {
  if (depth > MAX_SYMLINK_RESOLUTIONS) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      `Tool path exceeds the maximum symbolic-link resolution depth: path=${absolutePath}`,
      {
        context: {
          maxSymlinkResolutions: MAX_SYMLINK_RESOLUTIONS,
          path: absolutePath,
        },
        recoverable: true,
      },
    );
  }

  // 从卷根开始逐段走：Windows 的盘符属于 root，不能当成普通段再 resolve。
  const root = parse(absolutePath).root;
  const segments = absolutePath
    .slice(root.length)
    .split(sep)
    .filter((segment) => segment.length > 0);
  let current: string = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = resolve(current, segment);
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(candidate);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      // 不存在的段（含 dangling target 的尾段）按字面路径继续，最终由边界判定。
      current = candidate;
      continue;
    }
    if (!entry.isSymbolicLink()) {
      // 已存在段仍走 realpath：非 symlink 的文件系统别名（挂载/firmlink）也必须与边界同源。
      current = realpathSync(candidate);
      continue;
    }
    if (visitedLinks.has(candidate)) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        `Tool path contains a symbolic-link cycle: path=${absolutePath}, link=${candidate}`,
        {
          context: {
            link: candidate,
            path: candidate,
          },
          recoverable: true,
        },
      );
    }
    visitedLinks.add(candidate);
    const target = readlinkSync(candidate);
    const targetPath = isAbsolute(target) ? normalize(target) : resolve(dirname(candidate), target);
    const remainingSegments = segments.slice(index + 1);
    const resolvedTarget = resolveSymlinkChain(targetPath, depth + 1, visitedLinks);
    if (remainingSegments.length === 0) return resolvedTarget;
    return resolveSymlinkChain(
      resolve(resolvedTarget, ...remainingSegments),
      depth + 1,
      visitedLinks,
    );
  }
  return current;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isPathWithinBoundary(candidate: string, boundary: string): boolean {
  if (candidate === boundary) return true;
  const prefix = boundary.endsWith(sep) ? boundary : `${boundary}${sep}`;
  return candidate.startsWith(prefix);
}

function normalizeAbsoluteDirectory(value: string, label: string): string {
  const normalized = normalize(value);
  if (!isAbsolute(normalized)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `${label} must be an absolute path for tool execution`,
      {
        context: {
          [label]: value,
        },
        recoverable: false,
      },
    );
  }
  return normalized;
}
