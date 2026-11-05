import { useCallback, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { WouldAcceptPromoteRpc } from "@zcode/shared/zcode-protocol-v4";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/**
 * 批转 auto 的服务缝（= 写 mandate 行，spec §2.1 `super-agent-mandate.promoteWouldAccept`）。
 *
 * 合同类型定义在 @zcode/shared（WouldAcceptPromoteRpc）：UI 缝探测与 wave 2 的 mandate
 * 模块实现 import 同一签名，命名漂移在编译期/集成期就暴露，而不是探测键静默不命中。
 * RPC 本体在 wave 2 才由 mandate 服务实现并挂到 IServiceAccessor；在此之前 hook 通过
 * 结构探测得到 `configured=false` 的未接入态——这是如实状态，不是 mock，也没有假数据。
 * 组合根注入兼容实现后，本 hook 不需要改动。
 */
export type IWouldAcceptPromoteService = WouldAcceptPromoteRpc;

type MandateSeamAccessor = IServiceAccessor & {
  mandateService?: Partial<WouldAcceptPromoteRpc>;
};

export type WouldAcceptPromoteController =
  | { configured: false }
  | {
      configured: true;
      status: "idle" | "promoting" | "failed";
      error: string | null;
      /** 已成功批转的卡片 id（仅作展示抑制；权威仍是快照投影）。 */
      promotedCardIds: ReadonlySet<string>;
      promoteWouldAccept: (cardId: string) => Promise<boolean>;
    };

/**
 * would-accept「批转 auto」动作控制器。
 *
 * 走既有 `useOptionalServices()` 服务钩子缝；未在 ServiceProvider 内、或宿主尚未挂
 * mandateService 时返回 `{ configured: false }`，组件据此禁用入口并如实提示未接入。
 */
export function useWouldAcceptPromote(
  /**
   * 宿主注入的批转实现（优先于 `services.mandateService`）：
   * v4 会话 pane 用已持有的命令传输面（sendCommand）实现 `promoteWouldAccept` RPC，
   * 不要求 ServiceAccessor 再挂一份 mandate 服务；测试也经此注入测试替身。
   */
  override?: WouldAcceptPromoteRpc,
): WouldAcceptPromoteController {
  const services = useOptionalServices() as MandateSeamAccessor | null;
  const impl = override ?? services?.mandateService;
  const promoteImpl = impl?.promoteWouldAccept;
  const [status, setStatus] = useState<"idle" | "promoting" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [promotedCardIds, setPromotedCardIds] = useState<ReadonlySet<string>>(() => new Set());

  const promoteWouldAccept = useCallback(
    async (cardId: string): Promise<boolean> => {
      if (typeof promoteImpl !== "function" || !impl) {
        // 理论到不了这里：未接入时入口已禁用。到得了就响亮失败，不兜底。
        throw new Error("would-accept promote service is not configured");
      }
      setStatus("promoting");
      setError(null);
      try {
        await promoteImpl.call(impl, cardId);
        setStatus("idle");
        setPromotedCardIds((current) => {
          const next = new Set(current);
          next.add(cardId);
          return next;
        });
        return true;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn("[would-accept] promoteWouldAccept failed", { message });
        setStatus("failed");
        setError(message);
        return false;
      }
    },
    [promoteImpl, impl],
  );

  if (typeof promoteImpl !== "function") return { configured: false };
  return { configured: true, status, error, promotedCardIds, promoteWouldAccept };
}
