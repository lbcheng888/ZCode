// ============================================================
// Permission Service - Permission checking and decision making
// ============================================================

import {
  AMEND_WORKFLOW_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  isAmendWorkflowOwnedPredecessor,
  isFillWorkflowHoleOwnedRun,
  PermissionCapabilityGroup,
  type PermissionCapabilityGroup as PermissionCapabilityGroupType,
  type PermissionRuleValue,
  type PermissionRuleset,
  type PermissionUpdate,
  type CollaborationMode,
  type ModelToolSideEffectScope,
  type RiskLevel,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import { getCurrentTraceContext } from "@zcode/contracts";
import {
  OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME,
  composeAttachmentPermissionDecision,
  evaluateAttachmentToolRestriction,
  parseAttachmentRole,
} from "@zcode/shared";
import type { HostAttachmentAdmissionFacts } from "@zcode/shared/zcode-protocol-v4";
import {
  evaluateCapabilityTicketRestriction,
  type CapabilityTicketAuthorization,
} from "./capability-ticket.js";
import { readEscapesWorkspace } from "./attachment-workspace.js";
import { resolvePlanModeTransitionPermission } from "./plan-mode-policy.js";
import { webFetchRuleSubjects, wildcardToRegExp } from "./rule-matching.js";
import { isPreapprovedWorkflowDraftWrite } from "./workflow-draft-path.js";
import { applyPermissionUpdates } from "../tool/executor/permission-rules.js";
import { isWebFetchPreapprovedUrl } from "../tool/webfetch-preapproved.js";
import type { ToolPermissionRulePolicy } from "../tool/types.js";

// -----------------------------------------------
// Types
// -----------------------------------------------

/** 草稿免确认的规则号。 */
const WORKFLOW_DRAFT_PREAPPROVED_RULE_ID = "tool.workflowDraft.preapproved";

/**
 * M4 回合权限绑定的进程内上限。正常回合按唯一 turnId 建键、回合结束即删；上限只兜住
 * 异常未释放路径，避免进程生命周期内无界增长。达到上限按插入顺序淘汰最旧项
 * （仍在执行的回合极难触顶：1024 个未完成准入）。
 */
const MAX_BOUND_TURN_PERMISSION_FACTS = 1024;

/** M4 例外①：控制面自会话（裁决 / watchdog-llm）的基础设施 mandateId。 */
export const INFRASTRUCTURE_MANDATE_ID = "infrastructure";

/** mandate 档位（与 super-agent-mandate 的 MandateTier 同词汇，spec §1.4）。 */
export type PermissionMandateTier = "record_only" | "speculative" | "auto";

/** prompt admission 异步解析后注入的 mandate 结论（M4：管线内只读，不再查库）。 */
export interface PermissionMandateFacts {
  tier: PermissionMandateTier;
  /** 命中的显式 mandateId；基础设施豁免用 INFRASTRUCTURE_MANDATE_ID。 */
  mandateId?: string;
  /** epoch ms；null/缺席 = 不设过期。turn 内过期不中断，下一 admission 边界 revalidate。 */
  expiresAt?: number | null;
}

/**
 * 工具调用来源（M4 例外②）：user-origin 回合短路 mandate 检查；只有事件驱动的
 * 工具调用受 mandate fail-closed 门约束。缺省按 user 处理（flag 关字节兼容）。
 */
export type PermissionOrigin = "user" | "event";

/**
 * M4：一个回合的权限事实。由 prompt admission 在准入边界绑定，回合内所有工具判定复用
 * 同一份结论（turn 内不重新解析；下一 admission 边界自然拿到新结论）。
 */
export interface TurnPermissionFacts {
  mandate?: PermissionMandateFacts;
  origin?: PermissionOrigin;
  /**
   * P6：本回合 prompt admission 绑定的宿主附件事实。缺失 = 无 attachment 语义（本地
   * CLI/TUI 保持 host 现状）。来源与角色由 Host 显式给出，不从命令内容推断。
   */
  attachment?: HostAttachmentAdmissionFacts;
  /**
   * P6：本回合命令携带的能力票据授权域（宿主 broker 已校验，公开事实，无 secret）。
   * 缺失 = 本命令未声明 ticket 语义（字节兼容）；在场则工具准入按 scope 只收紧。
   */
  capabilityTicket?: CapabilityTicketAuthorization;
}

export interface PermissionContext {
  toolName: string;
  input: unknown;
  riskLevel: RiskLevel;
  mode: CollaborationMode;
  planEnabled?: boolean;
  prePlanMode?: Exclude<CollaborationMode, "plan">;
  /**
   * 会话工作目录。判定相对路径的落点用（目前只有 workflow 草稿免确认这一条），
   * 可选：拿不到工作目录的调用方照常按其余规则判定，不会因此少一层确认。
   */
  workingDirectory?: string;
  /** M4：prompt admission 注入的 mandate 结论；flag 关/用户回合时缺席。 */
  mandate?: PermissionMandateFacts;
  /** M4 例外②：缺省 user（既有调用方零行为变化）；事件驱动回合必须显式 event。 */
  origin?: PermissionOrigin;
  /**
   * P6：宿主 attachment 上下文（权威角色来自 Desktop attachment registry）。缺失 =
   * 本地/CLI 无 attachment 语义，保持 host 现状；远端来源但元数据缺失时由准入层按
   * read_mostly fail-closed，不能只看字段是否存在。
   */
  attachment?: HostAttachmentAdmissionFacts;
  /**
   * P6：本命令携带的票据授权域（由 prompt admission 绑定）。在场 = 该命令声明了 ticket
   * 语义，工具准入必须叠加 scope（只收紧）；缺席 = 旧路径，零行为变化。
   */
  capabilityTicket?: CapabilityTicketAuthorization;
}

export interface PermissionToolCapability {
  userApprovalRule?: string;
  allowedInPlanMode?: boolean;
  alwaysAsk?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  requiresUserInteraction?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  riskLevel?: RiskLevel;
  needsApproval?: boolean;
  permissionCapabilityGroup?: PermissionCapabilityGroupType;
  permission?: ToolPermissionSpec;
}

export type PermissionBehavior = "allow" | "ask" | "deny";

export interface PermissionDecisionResult {
  approvalMode?: "user-once";
  decision: PermissionBehavior;
  allowed: boolean;
  reason?: string;
  modifiedInput?: unknown;
  escalated: boolean;
  mode: CollaborationMode;
  ruleId: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  /**
   * 该 ask 来自工具的 alwaysAsk 声明，不是模式或规则推导出来的。下游（PreToolUse hook 的
   * allow 覆盖）靠这个结构化标记识别"不可抹掉的确认"，而不是去匹配 ruleId 字符串。
   */
  alwaysAsk?: boolean;
}

// -----------------------------------------------
// Permission Service
// -----------------------------------------------

export class PermissionService {
  /**
   * 会话级 allow 规则（「Always allow in this session」）。
   * 一个实例 = 一个 app = 一个会话，所以"随会话消亡"不需要任何额外机制：重启 / 冷恢复 / `/new`
   * 都会造一个空的新实例。只服务 alwaysAsk gate（见 checkAlwaysAsk），普通工具的模式语义不认它。
   */
  private sessionRules: PermissionRuleset = { version: 1 };

  /**
   * M4：admission 边界绑定、回合内复用的权限事实。键 = `<sessionId>\0<turnId>`。
   * turnId 由运行时每次真正起轮时新建，客户端无法复用（queryId/commandId 可被客户端
   * 重复使用，不能作为权威身份）；回合结束在 releaseTurnStart 显式删除。
   * 上限只是进程内守卫，防止异常路径下未释放的条目无限积累。
   */
  private readonly turnPermissionFacts = new Map<string, TurnPermissionFacts>();

  constructor(private config: PermissionConfig = defaultPermissionConfig) {}

  grantSessionPermission(updates: PermissionUpdate[]): void {
    this.sessionRules = applyPermissionUpdates(this.sessionRules, updates);
  }

  /**
   * prompt admission 的唯一写入点（M4）：把本回合解析出的 mandate 结论与来源绑定到
   * 该回合的 trace 作用域。flag 关 / user 回合从不调用，零行为变化。
   */
  bindTurnPermissionFacts(input: {
    sessionId: string;
    turnId: string;
    facts: TurnPermissionFacts;
  }): void {
    const key = turnPermissionFactsKey(input.sessionId, input.turnId);
    if (!this.turnPermissionFacts.has(key)) {
      while (this.turnPermissionFacts.size >= MAX_BOUND_TURN_PERMISSION_FACTS) {
        const oldest = this.turnPermissionFacts.keys().next().value;
        if (oldest === undefined) break;
        this.turnPermissionFacts.delete(oldest);
      }
    }
    this.turnPermissionFacts.set(key, input.facts);
  }

  /**
   * M4：回合结束时删除该回合绑定，防止事实跨回合残留。turnId 不可复用，
   * 即使删除遗漏也不会被后续回合命中；删除只是收敛内存。
   */
  releaseTurnPermissionFacts(input: { sessionId: string; turnId: string }): void {
    this.turnPermissionFacts.delete(turnPermissionFactsKey(input.sessionId, input.turnId));
  }

  /**
   * 当前回合绑定的事实（没有绑定时 undefined = 既有 user-origin 语义）。
   * 直接读 trace 的 async-local 作用域，调用方不需要把 mandate 逐层搬运。
   */
  private currentTurnPermissionFacts(): TurnPermissionFacts | undefined {
    const trace = getCurrentTraceContext();
    if (!trace?.turnId) return undefined;
    return this.turnPermissionFacts.get(
      turnPermissionFactsKey(String(trace.sessionId ?? ""), String(trace.turnId)),
    );
  }

  checkPermission(
    context: PermissionContext,
    toolCapability?: PermissionToolCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    const permissionContext = this.resolveEffectivePermissionContext(context);
    const decision = this.checkPermissionPipeline(
      permissionContext,
      toolCapability,
      projectRules,
      rulePolicy,
    );
    // P6 §1.3：附件矩阵必须在既有有序管线的**最终结论**之后叠加，且只收紧
    // （deny > ask > allow）。这里包住整个管线而非逐个 return 改，保证 mandate/plan/
    // alwaysAsk/yolo allow 等所有早返回分支都经过同一层，不会出现「allow 早返回漏叠加」。
    // 票据 scope 同样叠加在最终结论之后，且只 deny：命令声明票据语义时，超出 scope 的
    // 工具不能被既有 allow 规则或 yolo 模式重新放行。
    return this.applyCapabilityTicketRestriction(
      permissionContext,
      toolCapability,
      this.applyAttachmentRestriction(permissionContext, toolCapability, decision),
    );
  }

  /**
   * P6 能力票据 scope 叠加（spec §2.5 C1/C2）。见 capability-ticket.ts：
   * 过期 / 越界 / credential 注入不可达全部 typed deny，绝不放宽既有结论。
   */
  private applyCapabilityTicketRestriction(
    context: PermissionContext,
    toolCapability: PermissionToolCapability | undefined,
    decision: PermissionDecisionResult,
  ): PermissionDecisionResult {
    const authorization = context.capabilityTicket;
    if (authorization === undefined) return decision;
    const capability = this.resolveCapability(context, toolCapability);
    const restriction = evaluateCapabilityTicketRestriction({
      authorization,
      toolName: context.toolName,
      permissionGroup: capability.permissionCapabilityGroup,
    });
    if (restriction === undefined || decision.decision === "deny") return decision;
    return {
      ...decision,
      decision: "deny",
      allowed: false,
      escalated: false,
      ruleId: restriction.ruleId,
      reason: restriction.reason,
    };
  }

  /** M4：显式字段优先；缺省取 admission 绑定的回合事实（未绑定 = 保持现状）。 */
  private resolveEffectivePermissionContext(context: PermissionContext): PermissionContext {
    const bound = this.currentTurnPermissionFacts();
    if (!bound) return context;
    return {
      ...context,
      ...(context.mandate === undefined && bound.mandate !== undefined
        ? { mandate: bound.mandate }
        : {}),
      ...(context.origin === undefined && bound.origin !== undefined
        ? { origin: bound.origin }
        : {}),
      ...(context.attachment === undefined && bound.attachment !== undefined
        ? { attachment: bound.attachment }
        : {}),
      ...(context.capabilityTicket === undefined && bound.capabilityTicket !== undefined
        ? { capabilityTicket: bound.capabilityTicket }
        : {}),
    };
  }

  private checkPermissionPipeline(
    permissionContext: PermissionContext,
    toolCapability?: PermissionToolCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    const capability = this.resolveCapability(permissionContext, toolCapability);
    // M4：mandate 同步 fail-closed 门——插入点必须在 plan-transition 解析之前（管线最前端）。
    // 只认 admission 注入的 typed 结论，本层不查库（同步管线无法查库）。
    const mandateGate = this.resolveMandateGate(permissionContext, capability);
    if (mandateGate) return mandateGate;
    const planModeTransition = resolvePlanModeTransitionPermission(permissionContext);

    if (planModeTransition) {
      return planModeTransition.behavior === "allow"
        ? this.allow(
            permissionContext,
            capability,
            planModeTransition.ruleId,
            planModeTransition.reason,
          )
        : this.deny(
            permissionContext,
            capability,
            planModeTransition.ruleId,
            planModeTransition.reason,
          );
    }

    if (capability.requiresUserInteraction) {
      if (this.config.disallowedTools.has(permissionContext.toolName)) {
        return this.deny(
          permissionContext,
          capability,
          "rule.disallowedTools",
          `Tool ${permissionContext.toolName} is explicitly disallowed`,
        );
      }

      return this.ask(
        permissionContext,
        capability,
        "tool.userInteraction",
        `Tool ${permissionContext.toolName} requires user interaction`,
      );
    }

    // 独立 Plan 优先于 Guarded 的 YOLO 基础策略，审批不能解除 Plan 的执行限制。
    const planEnabled = permissionContext.planEnabled ?? permissionContext.mode === "plan";
    if (
      !planEnabled &&
      permissionContext.mode === "guarded" &&
      toolCapability?.userApprovalRule
    ) {
      return {
        ...this.ask(
          permissionContext,
          capability,
          toolCapability.userApprovalRule,
          "Dangerous command requires your approval for this execution",
        ),
        approvalMode: "user-once",
      };
    }

    // 保留 staging 的工具级确认，不被 Guarded 普通调用的 YOLO 基础策略跳过。
    if (capability.alwaysAsk) {
      return this.checkAlwaysAsk(permissionContext, capability, projectRules, rulePolicy);
    }

    if ((permissionContext.mode === "yolo" || permissionContext.mode === "guarded") && !planEnabled) {
      return this.allow(
        permissionContext,
        capability,
        "mode.yolo",
        "Yolo mode bypasses permission prompts",
      );
    }

    if (permissionContext.mode === "auto") {
      return this.deny(
        permissionContext,
        capability,
        "mode.auto.unimplemented",
        "Auto mode is reserved but not implemented yet",
      );
    }

    if (this.config.disallowedTools.has(permissionContext.toolName)) {
      return this.deny(
        permissionContext,
        capability,
        "rule.disallowedTools",
        `Tool ${permissionContext.toolName} is explicitly disallowed`,
      );
    }

    if (this.matchesProjectRules(projectRules, "deny", permissionContext, capability, rulePolicy)) {
      return this.deny(
        permissionContext,
        capability,
        "rule.project.deny",
        `Tool ${permissionContext.toolName} is denied by project permission rules`,
      );
    }

    if (this.matchesProjectRules(projectRules, "ask", permissionContext, capability, rulePolicy)) {
      return this.ask(
        permissionContext,
        capability,
        "rule.project.ask",
        `Tool ${permissionContext.toolName} requires approval by project permission rules`,
      );
    }

    // 原会话回复的接收范围由 Host 再次校验；network 副作用不能让这个免审批契约重新弹窗。
    // 放在显式 deny/ask 之后，且同时匹配内置工具名和能力，不能扩大其他网络工具的权限。
    if (
      permissionContext.toolName === "ReplyToChannel" &&
      capability.permissionName === "channel.reply" &&
      capability.sideEffectScope === "network" &&
      capability.riskLevel === "medium" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        permissionContext,
        capability,
        "tool.channelReply.preapproved",
        "The originating bot conversation is already authorized",
      );
    }

    if (planEnabled) {
      return this.checkPlanMode(permissionContext, capability);
    }

    if (this.matchesProjectRules(projectRules, "allow", permissionContext, capability, rulePolicy)) {
      return this.allow(
        permissionContext,
        capability,
        "rule.project.allow",
        `Tool ${permissionContext.toolName} is allowed by project permission rules`,
      );
    }

    if (this.isPreapprovedWebFetchRequest(permissionContext)) {
      return this.allow(
        permissionContext,
        capability,
        "tool.webfetch.preapproved",
        "WebFetch URL is preapproved",
      );
    }

    // workflow 草稿免确认：
    // 与 WebFetch 预批同一位次——排在 plan 分支之后，因为 plan 模式必须继续拦下一切写入，
    // 草稿也是写入；也排在项目 deny / ask 之后，项目规则照样压得过它。判定本身见
    // workflow-draft-path.ts（含"为什么这样放行是安全的"）。
    if (
      isPreapprovedWorkflowDraftWrite({
        input: permissionContext.input,
        toolName: permissionContext.toolName,
        workingDirectory: permissionContext.workingDirectory,
      })
    ) {
      return this.allow(
        permissionContext,
        capability,
        WORKFLOW_DRAFT_PREAPPROVED_RULE_ID,
        "Workflow draft file is preapproved",
      );
    }

    if (this.config.allowedTools.has(permissionContext.toolName)) {
      return this.allow(
        permissionContext,
        capability,
        "rule.allowedTools",
        `Tool ${permissionContext.toolName} is explicitly allowed`,
      );
    }

    if (permissionContext.mode === "edit") {
      return this.checkEditMode(permissionContext, capability);
    }

    return this.checkBuildMode(permissionContext, capability);
  }

  /**
   * P6 设备权限矩阵叠加（spec §1.3 / §1.4）。
   *
   * - 无 attachment 事实 = 本地/CLI 无 attachment 语义，返回既有结论（字节兼容）。
   * - 事实存在但 attachment 元数据缺失且来源 remote = read_mostly fail-closed（D4）。
   * - attachment 在场但角色缺失 = 已吊销/查不到 ⇒ 直接 deny（D5），绝不降成 read_mostly。
   * - host 角色 = 沿用既有管线，不产生额外限制。
   *
   * D3 缺口（如实登记）：read_mostly/interactive 的写操作 ask 目前仍走既有 permission
   * broker；宿主确认面路由尚未实现，因此末尾不伪造 host-confirmation 字段。
   */
  private applyAttachmentRestriction(
    context: PermissionContext,
    toolCapability: PermissionToolCapability | undefined,
    decision: PermissionDecisionResult,
  ): PermissionDecisionResult {
    const facts = context.attachment;
    if (!facts) return decision;
    const capability = this.resolveCapability(context, toolCapability);
    let role: ReturnType<typeof parseAttachmentRole> | undefined;
    if (facts.attachment) {
      if (facts.attachment.role === undefined) {
        if (decision.decision === "deny") return decision;
        return {
          ...decision,
          decision: "deny",
          allowed: false,
          escalated: false,
          ruleId: "attachment.revoked",
          reason: `Attachment ${facts.attachment.attachmentId} role is revoked or unresolved; fail-closed`,
        };
      }
      role = parseAttachmentRole(facts.attachment.role);
    } else if (facts.source === "remote") {
      // 远端连接但 attachment 元数据缺失：按最受限角色处理，不落到 host。
      role = "read_mostly";
    } else {
      return decision;
    }
    if (role === "host") return decision;

    const restriction = evaluateAttachmentToolRestriction({
      role,
      toolName: context.toolName,
      permissionGroup: capability.permissionCapabilityGroup,
    });
    // spec §1.3：纯读只允许在 workspace 内。矩阵的 `read: allow` 没有路径边界，必须在这里
    // 加上；否则被攻破的远端可读宿主任意文件（~/.ssh、env）。workspace 外 fail-closed。
    if (restriction?.toolClass === "read" && readEscapesWorkspace(context)) {
      return {
        ...decision,
        decision: "deny",
        allowed: false,
        escalated: false,
        ruleId: "attachment.workspaceEscape",
        reason: `Attachment role ${role} may read only within the workspace; path escapes working directory`,
      };
    }
    const composed = composeAttachmentPermissionDecision(decision.decision, restriction);
    if (composed === decision.decision || !restriction) return decision;
    return {
      ...decision,
      decision: composed,
      allowed: composed === "allow",
      escalated: composed === "ask",
      ruleId: restriction.ruleId,
      reason: restriction.reason,
    };
  }

  /**
   * M4 mandate 同步 fail-closed 门（设计原文三条例外）：
   * - ② origin=user 回合短路（缺省 user，既有调用方零行为变化）；
   * - ① 基础设施 mandateId（裁决 / watchdog-llm 自会话）豁免；
   * - 写操作要求显式有效 mandate：缺失 / 过期 / record_only ⇒ deny；
   *   speculative/auto 且缺 mandateId ⇒ deny（例外③：originMeta 必带 mandateId）。
   * 只读（无副作用的 none 域）工具不受限：mandate 管「这件事轮不轮到你主动做」，
   * 不是读工具闸。返回 undefined = 放行到后续既有管线。
   */
  private resolveMandateGate(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult | undefined {
    if ((context.origin ?? "user") !== "event") return undefined;
    if (!this.isWriteOperation(capability)) return undefined;
    const mandate = context.mandate;
    if (mandate?.mandateId === INFRASTRUCTURE_MANDATE_ID) return undefined;
    if (!mandate) {
      return this.deny(
        context,
        capability,
        "mandate.missing",
        "Event-origin tool call has no mandate verdict (fail-closed)",
      );
    }
    if (mandate.expiresAt != null && mandate.expiresAt <= Date.now()) {
      return this.deny(
        context,
        capability,
        "mandate.expired",
        "Mandate expired; revalidation is required at the next admission boundary",
      );
    }
    if (mandate.tier === "record_only") {
      return this.deny(
        context,
        capability,
        "mandate.recordOnly",
        "Record-only mandate cannot execute write operations",
      );
    }
    if (!mandate.mandateId) {
      return this.deny(
        context,
        capability,
        "mandate.missingId",
        "Speculative/auto turn must carry a mandateId",
      );
    }
    return undefined;
  }

  private isWriteOperation(capability: ResolvedPermissionCapability): boolean {
    return capability.destructive || !capability.readOnly || capability.sideEffectScope !== "none";
  }

  private matchesProjectRules(
    ruleset: PermissionRuleset | null | undefined,
    behavior: PermissionBehavior,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    rulePolicy?: ToolPermissionRulePolicy,
  ): boolean {
    const rules = ruleset?.[behavior];
    if (!Array.isArray(rules)) return false;
    const toolRules = rules.filter((rule) =>
      this.matchesRuleScope(rule, context.toolName, capability),
    );
    if (toolRules.length === 0) return false;
    if (rulePolicy) return rulePolicy.evaluateRules(behavior, toolRules);
    return toolRules.some((rule) => this.matchesRule(rule, context, capability));
  }

  private matchesRule(
    rule: PermissionRuleValue,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): boolean {
    if (!this.matchesRuleScope(rule, context.toolName, capability)) return false;
    if (!rule.ruleContent) return true;

    const subjects = this.ruleSubjects(context.input, context.toolName);
    if (subjects.length === 0) return false;

    return subjects.some((subject) => this.matchesRuleContent(subject, rule.ruleContent!));
  }

  private matchesRuleToolName(ruleToolName: string, contextToolName: string): boolean {
    if (ruleToolName === contextToolName) return true;
    return contextToolName === "Write" && ruleToolName === "Edit";
  }

  private matchesRuleScope(
    rule: PermissionRuleValue,
    contextToolName: string,
    capability: ResolvedPermissionCapability,
  ): boolean {
    if (rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME) {
      // 保留 key 只有在当前 tool entry 另行携带宿主验证后的 official_cua
      // capability 时才匹配。同名第三方 MCP、authority 漂移以及旧普通 tool
      // 都不能把可解析的 wire/storage 字符串升级成可信能力。
      return capability.permissionCapabilityGroup === PermissionCapabilityGroup.OfficialCua;
    }
    return this.matchesRuleToolName(rule.toolName, contextToolName);
  }

  private ruleSubjects(input: unknown, toolName: string): string[] {
    if (typeof input === "string") return [input];
    if (!input || typeof input !== "object") return [];

    const record = input as Record<string, unknown>;
    if (toolName === "WebFetch" && typeof record.url === "string") {
      return webFetchRuleSubjects(record.url);
    }

    for (const key of ["command", "url", "file_path", "path", "pattern", "patch_text"]) {
      const value = record[key];
      if (typeof value === "string") return [value];
    }

    return [];
  }

  private isPreapprovedWebFetchRequest(context: PermissionContext): boolean {
    if (context.toolName !== "WebFetch") return false;
    if (!context.input || typeof context.input !== "object") return false;
    const url = (context.input as Record<string, unknown>).url;
    return typeof url === "string" && isWebFetchPreapprovedUrl(url);
  }

  private matchesRuleContent(subject: string, ruleContent: string): boolean {
    if (ruleContent.endsWith(":*")) {
      const prefix = ruleContent.slice(0, -2);
      return (
        subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`)
      );
    }

    if (ruleContent.includes("*")) {
      return wildcardToRegExp(ruleContent).test(subject);
    }

    return subject === ruleContent;
  }

  /**
   * 工具自报 alwaysAsk 时的判定：ask 压过所有"放行"分支（yolo 直通、plan 的 readOnly 直通），
   * 但**压不过"阻断"**——所以这里先自己走一遍硬阻断判定。
   *
   * 为什么不直接返回 ask：disallowedTools 是用户配置的硬禁用，项目 deny 规则符合工具自报的
   * denyPriority: "beforeAsk"，auto 模式是"该模式未实现"的保护。少了这一步，一个被硬禁用的
   * 工具会退化成"弹个窗、用户一点就能跑"。
   *
   * 这些判定在 checkPermission 里按原有顺序还会各自出现一次；此处刻意只覆盖 alwaysAsk 工具，
   * 不改动其他工具的既有优先级（尤其 yolo 目前先于 disallowedTools 放行这一点）。
   */
  private checkAlwaysAsk(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    if (context.mode === "auto") {
      return this.deny(
        context,
        capability,
        "mode.auto.unimplemented",
        "Auto mode is reserved but not implemented yet",
      );
    }
    if (this.config.disallowedTools.has(context.toolName)) {
      return this.deny(
        context,
        capability,
        "rule.disallowedTools",
        `Tool ${context.toolName} is explicitly disallowed`,
      );
    }
    if (this.matchesProjectRules(projectRules, "deny", context, capability, rulePolicy)) {
      return this.deny(
        context,
        capability,
        "rule.project.deny",
        `Tool ${context.toolName} is denied by project permission rules`,
      );
    }
    // 会话免确认：阻断分支之后、ask 之前。命中即放行，不发 permission 事件、不弹窗；
    // 与 gate 本身一样不看模式（yolo / plan / build 一致）。
    if (this.matchesProjectRules(this.sessionRules, "allow", context, capability, rulePolicy)) {
      return this.allow(
        context,
        capability,
        "rule.session.allow",
        `Tool ${context.toolName} was allowed for this session`,
      );
    }
    // 修订免确认：AmendWorkflow 的前驱是
    // **本会话发起**的 run、不是用户亲手停下的、且这次修订没有引入新 provider，即放行。与会话规则同位——阻断分支之后、ask 之前，
    // 不看模式。事实来自 resolveInput 回填的 `predecessor`（journal 的 parent_session_id / stopReason），
    // 不是内存表：重启、冷恢复后依然成立，也没有可播种、可撤销的东西。别的会话的 run、用户停过的
    // run 照常 ask：钥匙是 run 的归属，不是字段的在场。
    if (this.isOwnedWorkflowAmend(context)) {
      return this.allow(
        context,
        capability,
        "rule.session.workflowOwner",
        `Tool ${context.toolName} amends a run this session started`,
      );
    }
    return this.ask(
      context,
      capability,
      "tool.alwaysAsk",
      `Tool ${context.toolName} always requires explicit approval`,
    );
  }

  /**
   * AmendWorkflow 且回填的 `predecessor` 说「本会话的 run、非用户停下」；或 FillWorkflowHole 且回填的
   * `hole` 说同一件事（docs/dynamic-workflow/launch.md「Approval」：补全是对一个在飞 run 脚本的修订，
   * 由同一条 amend 规则判定）。
   */
  private isOwnedWorkflowAmend(context: PermissionContext): boolean {
    if (!context.input || typeof context.input !== "object") return false;
    const input = context.input as Record<string, unknown>;
    // 谓词本体住在契约里：就地调并发落回修订时读的必须是同一条规则，不能各写一遍。
    if (context.toolName === AMEND_WORKFLOW_TOOL_NAME) {
      return isAmendWorkflowOwnedPredecessor(input.predecessor);
    }
    if (context.toolName === FILL_WORKFLOW_HOLE_TOOL_NAME) {
      return isFillWorkflowHoleOwnedRun(input.hole);
    }
    return false;
  }

  private checkPlanMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.readOnly && !capability.destructive) {
      return this.allow(
        context,
        capability,
        "mode.plan.readOnly",
        "Plan mode allows read-only tool execution",
      );
    }

    if (this.isMcpToolCapability(capability) && !capability.destructive) {
      return this.allow(
        context,
        capability,
        "mode.plan.mcp",
        "Plan mode allows non-destructive MCP tool execution",
      );
    }

    if (
      capability.allowedInPlanMode &&
      capability.sideEffectScope === "session" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "mode.plan.explicitSessionCapability",
        "Plan mode allows this explicit non-destructive session control action",
      );
    }

    return this.deny(
      context,
      capability,
      "mode.plan.nonReadOnly",
      "Plan mode only allows read-only, non-destructive tools",
    );
  }

  private isMcpToolCapability(capability: ResolvedPermissionCapability): boolean {
    return capability.permissionName === "mcp";
  }

  private checkBuildMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.readOnly && !capability.destructive && !capability.needsApproval) {
      return this.allow(
        context,
        capability,
        "mode.build.readOnly",
        "Build mode allows read-only tools",
      );
    }

    if (capability.riskLevel === "critical") {
      return this.ask(
        context,
        capability,
        "mode.build.criticalRisk",
        "Critical risk tools require explicit approval",
      );
    }

    if (capability.riskLevel === "high" && !this.config.autoApproveHighRisk) {
      return this.ask(
        context,
        capability,
        "mode.build.highRisk",
        "High risk tools require explicit approval",
      );
    }

    if (
      capability.sideEffectScope === "session" &&
      capability.riskLevel === "low" &&
      !capability.destructive &&
      !capability.needsApproval
    ) {
      return this.allow(
        context,
        capability,
        "mode.build.sessionState",
        "Build mode allows low-risk session-local state updates",
      );
    }

    if (
      capability.needsApproval ||
      capability.destructive ||
      capability.sideEffectScope !== "none"
    ) {
      return this.ask(
        context,
        capability,
        "mode.build.sideEffect",
        "Tool has side effects and requires approval",
      );
    }

    return this.allow(
      context,
      capability,
      "mode.build.lowRisk",
      "Build mode allows low-risk tool execution",
    );
  }

  private checkEditMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.permissionName === "edit" && capability.sideEffectScope === "workspace") {
      return this.allow(
        context,
        capability,
        "mode.edit.fileEdit",
        "Edit mode allows file edit tools",
      );
    }

    return this.checkBuildMode(context, capability);
  }

  requiresApproval(context: PermissionContext, toolCapability?: PermissionToolCapability): boolean {
    const decision = this.checkPermission(context, toolCapability);
    return decision.decision === "ask";
  }

  getRiskLevel(toolName: string, toolCapability?: PermissionToolCapability): RiskLevel {
    if (toolCapability?.riskLevel) {
      return toolCapability.riskLevel;
    }

    if (this.isReadOnlyTool(toolName)) {
      return "low";
    }

    if (this.isWriteTool(toolName)) {
      return "medium";
    }

    if (this.isDestructiveTool(toolName)) {
      return "high";
    }

    return "medium";
  }

  private isReadOnlyTool(name: string): boolean {
    return new Set([
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "TodoRead",
      "TodoWrite",
      "AskUserQuestion",
      "Agent",
      "Task",
      "Skill",
    ]).has(name);
  }

  private isWriteTool(name: string): boolean {
    return new Set(["Write", "Edit", "ApplyPatch", "Bash"]).has(name);
  }

  private isDestructiveTool(name: string): boolean {
    return new Set(["Bash"]).has(name);
  }

  private resolveCapability(
    context: PermissionContext,
    toolCapability?: PermissionToolCapability,
  ): ResolvedPermissionCapability {
    return {
      allowedInPlanMode: toolCapability?.allowedInPlanMode ?? false,
      alwaysAsk: toolCapability?.permission?.alwaysAsk ?? toolCapability?.alwaysAsk ?? false,
      readOnly: toolCapability?.readOnly ?? this.isReadOnlyTool(context.toolName),
      destructive: toolCapability?.destructive ?? this.isDestructiveTool(context.toolName),
      requiresUserInteraction:
        toolCapability?.requiresUserInteraction ??
        (toolCapability?.permission?.sideEffectScope ?? toolCapability?.sideEffectScope) ===
          "userInteraction",
      sideEffectScope:
        toolCapability?.permission?.sideEffectScope ??
        toolCapability?.sideEffectScope ??
        (this.isReadOnlyTool(context.toolName) ? "none" : "workspace"),
      riskLevel:
        toolCapability?.permission?.riskLevel ??
        this.getRiskLevel(context.toolName, toolCapability),
      needsApproval:
        toolCapability?.permission?.needsApproval ??
        toolCapability?.needsApproval ??
        !this.isReadOnlyTool(context.toolName),
      permissionCapabilityGroup: toolCapability?.permissionCapabilityGroup,
      permissionName: toolCapability?.permission?.permission,
    };
  }

  private allow(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason?: string,
  ): PermissionDecisionResult {
    return this.result("allow", context, capability, ruleId, reason);
  }

  private ask(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason: string,
  ): PermissionDecisionResult {
    return this.result("ask", context, capability, ruleId, reason);
  }

  private deny(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason: string,
  ): PermissionDecisionResult {
    return this.result("deny", context, capability, ruleId, reason);
  }

  private result(
    decision: PermissionBehavior,
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    ruleId: string,
    reason?: string,
  ): PermissionDecisionResult {
    return {
      decision,
      allowed: decision === "allow",
      escalated: decision === "ask",
      mode: context.mode,
      reason,
      riskLevel: capability.riskLevel,
      ruleId,
      sideEffectScope: capability.sideEffectScope,
      ...(capability.alwaysAsk ? { alwaysAsk: true } : {}),
    };
  }
}

function turnPermissionFactsKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

interface ResolvedPermissionCapability {
  allowedInPlanMode: boolean;
  alwaysAsk: boolean;
  readOnly: boolean;
  destructive: boolean;
  requiresUserInteraction: boolean;
  sideEffectScope: ModelToolSideEffectScope;
  riskLevel: RiskLevel;
  needsApproval: boolean;
  permissionCapabilityGroup?: PermissionCapabilityGroupType;
  permissionName?: string;
}

// -----------------------------------------------
// Configuration
// -----------------------------------------------

export interface PermissionConfig {
  allowedTools: Set<string>;
  disallowedTools: Set<string>;
  autoApproveHighRisk: boolean;
  allowMediumRiskInAutoMode: boolean;
}

export const defaultPermissionConfig: PermissionConfig = {
  allowedTools: new Set(),
  disallowedTools: new Set(),
  autoApproveHighRisk: false,
  allowMediumRiskInAutoMode: false,
};
