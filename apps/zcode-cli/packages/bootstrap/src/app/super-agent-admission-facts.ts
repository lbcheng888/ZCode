// M4 mandateFacts 生产者与 prompt admission 之间的进程内交接面。
//
// 生产链：控制面在投递带 triggerId 的 sendText 信封前，用真 mandate 契约解析本回合
// 的档位结论并按 commandId 登记；宿主 handleCommand 包装层登记、input-facade 在
// admission 前按 inputId(=commandId) 取出并交给 Core。登记项在回合真正起步后删除，
// 排队输入保留到提升时的下一次 admission。
//
// 登记表必须进程级共享：协议宿主每个 session 一个 app，leader app 的 handleCommand
// 包装按 commandId 登记 facts，EventRouter/worker 却可能把同一信封投给另一个 session
// 的 app；若每个 app 各持一份表，目标 app 的 input-facade 会查到空表，事件回合就静默
// 退回 user-origin（fail-open）。同一进程内所有 create-app 注入同一实例即可收敛。

import type { PromptAdmissionOptions } from "@zcode/core";

/** 结构 = Core `PromptAdmissionOptions["mandateFacts"]`（mandate.resolveFor 三档结论 + triggerId）。 */
export type SuperAgentAdmissionMandateFacts = NonNullable<
  PromptAdmissionOptions["mandateFacts"]
>;

/**
 * 事件回合的 admission 结论，按 trigger_events.fast_path 分类（design M2:118）：
 * - `mandate`：owned / unowned_candidate 事件回合，按 resolveFor 三档授权；
 * - `human_explicit_exempt`：人类显式直通回合「免 Mandate」，按既有 user-origin
 *   语义执行，不绑定事件权限事实（否则未配置显式 mandate 的人类消息会被
 *   隐式 record_only 判成只读，人类直接对话退化为只读）。
 */
export type SuperAgentAdmissionMandateResolution =
  | { kind: "mandate"; facts: SuperAgentAdmissionMandateFacts }
  | { kind: "human_explicit_exempt" };

/**
 * 未起步/被拒准入的兜底上限。正常回合按唯一 commandId 建键、起步即删；上限只防止
 * 无限积累（登记项在删除前不会与新输入复用同一 commandId）。
 */
const MAX_ADMISSION_FACT_ENTRIES = 1024;

interface AdmissionFactEntry {
  resolution: SuperAgentAdmissionMandateResolution;
  /** 已排队、等待提升的项不能淘汰——淘汰会让提升后的 admission 静默退回 user-origin。 */
  retained: boolean;
}

export interface SuperAgentAdmissionMandateFactsRegistry {
  /**
   * 投递前登记（gateway.handleCommand 包装层唯一写入点；同 commandId 重投覆盖同值）。
   * 登记项同时携带 trigger 来源：input-facade 据此把来源交给 Core，facts 缺席时
   * prompt admission 会响亮失败而不是按 user-origin 放行。
   */
  bind(commandId: string, resolution: SuperAgentAdmissionMandateResolution): void;
  /** admission 前按 inputId 取结论；缺席 = 非事件回合（flag 关 / 未登记）。 */
  peek(commandId: string | undefined): SuperAgentAdmissionMandateResolution | undefined;
  /** 本命令是否按事件档位执行；human-explicit 免 Mandate = 不向 Core 声明 trigger 来源。 */
  triggerSourceOf(commandId: string | undefined): "trigger" | undefined;
  /** 排队输入标记为待提升：淘汰循环跳过该项。 */
  retain(commandId: string | undefined): void;
  /** 回合已起步 / 判定不可能再起轮时释放；排队输入不释放。 */
  drop(commandId: string | undefined): void;
}

export function createSuperAgentAdmissionMandateFactsRegistry(): SuperAgentAdmissionMandateFactsRegistry {
  const entries = new Map<string, AdmissionFactEntry>();
  return {
    bind(commandId, resolution) {
      const existing = entries.get(commandId);
      if (!existing && entries.size >= MAX_ADMISSION_FACT_ENTRIES) {
        // 只淘汰非排队项；全部在等提升 = 配置/吞吐异常，响亮失败而不是静默丢授权。
        let evicted = false;
        for (const [key, entry] of entries) {
          if (entry.retained) continue;
          entries.delete(key);
          evicted = true;
          break;
        }
        if (!evicted) {
          throw new Error(
            `mandate 登记表已达上限 ${MAX_ADMISSION_FACT_ENTRIES} 且全部为待提升项（commandId=${commandId}）`,
          );
        }
      }
      entries.set(commandId, {
        resolution,
        retained: existing?.retained ?? false,
      });
    },
    peek(commandId) {
      return commandId === undefined ? undefined : entries.get(commandId)?.resolution;
    },
    triggerSourceOf(commandId) {
      if (commandId === undefined) return undefined;
      // human-explicit 免 Mandate：不声明 trigger 来源，按既有 user-origin 执行。
      return entries.get(commandId)?.resolution.kind === "mandate" ? "trigger" : undefined;
    },
    retain(commandId) {
      const entry = commandId === undefined ? undefined : entries.get(commandId);
      if (entry) entry.retained = true;
    },
    drop(commandId) {
      if (commandId !== undefined) entries.delete(commandId);
    },
  };
}

/**
 * 进程级单例：协议宿主多 session app 与 CLI /new、/resume 换 app 都必须用同一份表，
 * 否则跨 app 投递会丢 facts（见文件头）。commandId 是 UUID，跨会话碰撞不在现实面。
 */
export const processSuperAgentAdmissionMandateFacts =
  createSuperAgentAdmissionMandateFactsRegistry();
