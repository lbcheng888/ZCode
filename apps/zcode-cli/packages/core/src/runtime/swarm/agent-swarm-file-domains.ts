// ============================================================
// AgentSwarm 文件域 lane 的校验与 prompt 构造
// ============================================================
// 从 agent-swarm.ts 拆出：该文件受 800 行 architecture 上限约束；文件域路径规范化、
// 去重、prompt 头和输出标签都只依赖 contracts，不需要进执行面。

import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { canonicalizeWorkspaceFilePath } from "../../tool/path-policy.js";
import {
  AGENT_SWARM_FILES_PLACEHOLDER,
  AGENT_SWARM_MAX_TOTAL_DOMAIN_FILES,
  dropTrailingHighSurrogate,
  type AgentSwarmFileDomain,
} from "@zcode/contracts";

/** 结果信封里的 domain 元数据；files 是 workspace 相对展示路径。 */
export interface AgentSwarmFileDomainInfo {
  /** 0-based domain index, reported as 1-based `domain` in the result envelope. */
  index: number;
  /** User-facing label for this lane. */
  description?: string;
  /** Workspace-relative display paths. */
  files: readonly string[];
}

export interface NormalizedFileDomain {
  displayFiles: string[];
  absoluteFiles: string[];
}

/** agent-swarm.ts 的 typed 拒绝工厂；避免本模块反向依赖执行面。 */
export type InvalidAgentSwarmInput = (message: string) => Error;

/** 文件域路径不允许换行/控制字符：一条路径不能把后续文本送回 prompt 的新行。 */
const FORBIDDEN_PATH_CHARS = /\r\n?|\n|[\u2028\u2029\u0085\v\f\u001c-\u001e\u0000]/u;
/** 换行变体统一成空格；description 只做展示，不能带出新的 prompt 行。 */
const LINE_BREAKS = /\r\n?|\n|[\u2028\u2029\u0085\v\f\u001c-\u001e]/gu;

/**
 * 文件域路径必须是 workspace 内的精确文件：绝对路径先收敛到 workspaceRoot 相对路径，
 * 越界、重名、换行/控制字符都在启动任何子代理前 typed 拒绝。
 */
export function normalizeFileDomain(
  domain: AgentSwarmFileDomain,
  domainIndex: number,
  workspaceRoot: string,
  seenFiles: Map<string, number>,
  invalid: InvalidAgentSwarmInput,
): NormalizedFileDomain {
  const displayFiles: string[] = [];
  const absoluteFiles: string[] = [];
  for (const rawFile of domain.files) {
    const file = rawFile.trim();
    if (file.length === 0) {
      throw invalid(`file domain ${domainIndex + 1} contains an empty file path`);
    }
    if (FORBIDDEN_PATH_CHARS.test(file)) {
      throw invalid(
        `file domain ${domainIndex + 1} contains a path with a line break or control character: ${truncateValidationPathSegment(file)}`,
      );
    }
    const absoluteFile = isAbsolute(file) ? normalize(file) : resolve(workspaceRoot, file);
    let canonicalFile: string;
    try {
      canonicalFile = canonicalizeWorkspaceFilePath(absoluteFile);
    } catch (error) {
      throw invalid(
        `file domain ${domainIndex + 1} path cannot be resolved: ${truncateValidationPathSegment(file)} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const relativeFile = relative(workspaceRoot, canonicalFile);
    if (
      relativeFile.length === 0 ||
      relativeFile === ".." ||
      relativeFile.startsWith(`..${sep}`) ||
      isAbsolute(relativeFile)
    ) {
      throw invalid(
        `file domain ${domainIndex + 1} path escapes the workspace: ${truncateValidationPathSegment(file)}`,
      );
    }
    const displayFile = normalize(relativeFile).split(sep).join("/");
    const previousDomain = seenFiles.get(canonicalFile);
    if (previousDomain !== undefined) {
      throw invalid(
        `file ${truncateValidationPathSegment(displayFile)} appears in both file domains ${previousDomain + 1} and ${domainIndex + 1}`,
      );
    }
    seenFiles.set(canonicalFile, domainIndex);
    displayFiles.push(displayFile);
    absoluteFiles.push(canonicalFile);
  }
  return { displayFiles, absoluteFiles };
}

export function normalizeFileDomainDescription(
  description: string | undefined,
): string | undefined {
  if (description === undefined) return undefined;
  const normalized = description.trim().replace(LINE_BREAKS, " ");
  return normalized.length === 0 ? undefined : normalized;
}

export function domainTaskDescription(
  description: string,
  domain: AgentSwarmFileDomainInfo,
): string {
  return `${description} · ${domain.description ?? `file domain ${domain.index + 1}`}`;
}

/**
 * 文件域 prompt 的 harness 头：明确写集与“只改这些文件”的约束，再把共享任务模板附在
 * `[Task]` 之后。模板里如果用了 {{files}}，列表在模板位置展开；否则由头部注入。
 */
export function buildFileDomainPrompt(
  domainIndex: number,
  domainCount: number,
  domain: NormalizedFileDomain,
  template: string,
): string {
  const filesText = domain.displayFiles.map((file) => `- ${file}`).join("\n");
  const hasFilesPlaceholder = template.includes(AGENT_SWARM_FILES_PLACEHOLDER);
  const task = hasFilesPlaceholder
    ? template.split(AGENT_SWARM_FILES_PLACEHOLDER).join(filesText)
    : template;
  const listBlock = hasFilesPlaceholder ? "" : `Only modify these files:\n${filesText}\n`;
  return [
    `[AgentSwarm file domain ${domainIndex + 1}/${domainCount}]`,
    listBlock + "Do not create or modify any other file. Reads are allowed.",
    "",
    "[Task]",
    task,
  ].join("\n");
}

/** 校验路径段上限；从 agent-swarm.ts 的 validation formatter 共用。 */
export function truncateValidationPathSegment(segment: string): string {
  const max = 80;
  if (segment.length <= max) return segment;
  return `${dropTrailingHighSurrogate(segment.slice(0, max - 1))}…`;
}

/** 一个可直接转成 AgentSwarm item job 的文件域 lane。 */
export interface FileDomainLane {
  /** 输出信封的 item 标签。 */
  item: string;
  /** domain 元数据（写进结果属性）。 */
  domain: AgentSwarmFileDomainInfo;
  /** 子代理卡片描述。 */
  description: string;
  /** 注入写域头后的完整 prompt。 */
  prompt: string;
  /** 本 lane 的绝对写白名单。 */
  allowedWritePaths: readonly string[];
}

/**
 * 校验并生成全部文件域 lane。所有拒绝都发生在 spawn 之前：模板缺失/含 {{item}}、
 * 路径越界/重复/含控制字符、domain 重复 prompt、总文件数或单 lane prompt 超限。
 */
export function planFileDomainLanes(
  fileDomains: readonly AgentSwarmFileDomain[],
  template: string | undefined,
  swarmDescription: string,
  workspaceRootInput: string,
  maxPromptChars: number,
  invalid: InvalidAgentSwarmInput,
): FileDomainLane[] {
  if (template === undefined || template.length === 0) {
    throw invalid("prompt_template is required when file_domains are provided");
  }
  if (template.includes("{{item}}")) {
    throw invalid(
      "prompt_template for file_domains must not contain {{item}}; list the lane's files or let the harness inject them",
    );
  }

  const workspaceRoot = canonicalizeWorkspaceFilePath(resolve(workspaceRootInput));
  const seenFiles = new Map<string, number>();
  const seenPrompts = new Map<string, number>();
  let totalFiles = 0;
  const lanes: FileDomainLane[] = [];

  for (const [domainIndex, domain] of fileDomains.entries()) {
    const normalized = normalizeFileDomain(
      domain,
      domainIndex,
      workspaceRoot,
      seenFiles,
      invalid,
    );
    totalFiles += normalized.displayFiles.length;
    if (totalFiles > AGENT_SWARM_MAX_TOTAL_DOMAIN_FILES) {
      throw invalid(
        `AgentSwarm file_domains cover at most ${AGENT_SWARM_MAX_TOTAL_DOMAIN_FILES} files; received ${totalFiles}`,
      );
    }
    const prompt = buildFileDomainPrompt(domainIndex, fileDomains.length, normalized, template);
    if (prompt.length > maxPromptChars) {
      throw invalid(
        `AgentSwarm file domain ${domainIndex + 1} prompt is ${prompt.length} characters; the limit is ${maxPromptChars}`,
      );
    }
    const previousPromptDomain = seenPrompts.get(prompt);
    if (previousPromptDomain !== undefined) {
      throw invalid(
        `file domains ${previousPromptDomain + 1} and ${domainIndex + 1} produce the same prompt; give each lane distinct files or a distinct description`,
      );
    }
    seenPrompts.set(prompt, domainIndex);

    const description = normalizeFileDomainDescription(domain.description);
    const domainInfo: AgentSwarmFileDomainInfo = {
      index: domainIndex,
      ...(description === undefined ? {} : { description }),
      files: normalized.displayFiles,
    };
    lanes.push({
      item: description ?? `file domain ${domainIndex + 1}`,
      domain: domainInfo,
      description: domainTaskDescription(swarmDescription, domainInfo),
      prompt,
      allowedWritePaths: normalized.absoluteFiles,
    });
  }
  return lanes;
}
