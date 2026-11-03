/**
 * super-agent-intake 实现：ingest = trigger_events 落行（唯一写入点）→ Fast Path →
 * 三边路由决策（不派发，动作归 super-agent-trigger，§3.1）。
 */
import type {
  CreateSuperAgentIntakeOptions,
  FastPathDisposition,
  IngestResult,
  IngestRoute,
  SuperAgentIntakeContract,
  TriggerEnvelope,
} from "./contract.js";
import { evaluateFastPath, mintDomainKeyFromEnvelope, mintThreadKey, UNSCOPED_THREAD_DOMAIN_KEY } from "./fast-path.js";
import {
  createTriggerEventsRepo,
  isUniqueConstraintError,
  type TriggerEventRow,
} from "./trigger-events.js";

const ADJUDICATION_PENDING = "pending";

function routeFromRow(row: TriggerEventRow): IngestRoute | undefined {
  if (row.finalDisposition === "rejected") return "rejected";
  if (row.fastPath) return row.fastPath;
  // 行在 Fast Path 收敛前崩溃（fast_path 仍 NULL 且未 rejected）→ 需重算，返回 undefined。
  return undefined;
}

function reasonForRoute(route: FastPathDisposition): string {
  return `fast-path-${route}`;
}

/** 创建 intake：句柄与端口全部由组合根注入（决策经结构类型，不 import 兄弟模块）。 */
export function createSuperAgentIntake(options: CreateSuperAgentIntakeOptions): SuperAgentIntakeContract {
  const { db, decisionLog, autoReplyGuard } = options;
  const now = options.now ?? Date.now;
  const events = createTriggerEventsRepo(db);

  async function convergeFastPath(
    envelope: TriggerEnvelope,
    triggerId: string,
    threadKey: string,
  ): Promise<IngestResult> {
    // Fast Path 含异步守卫，必须在事务外算完；下面的两写（行收敛 + decision_log）再进事务。
    const evaluation = await evaluateFastPath(db, envelope, threadKey, autoReplyGuard);
    const at = now();
    // 行收敛与 decision_log 必须同事务：分开写时 record 抛错/中间崩溃会留下
    // trigger_events 已收敛而 decision_log 缺行的常态路径（幂等短路永不补写）。
    // 事务前提：decisionLog 端口与 db 是同一库句柄（组合根注入同一 openSuperAgentDatabase）。
    db.exec("begin immediate");
    try {
      if (evaluation.outcome === "reject") {
        events.markRejected(triggerId, at);
        decisionLog.record({
          workspaceIdentity: envelope.workspaceIdentity,
          triggerId,
          origin: "fast_path",
          disposition: "reject",
          reason: `fast-path-rejected:${evaluation.reason}`,
          createdAt: at,
        });
        db.exec("commit");
        return { triggerId, route: "rejected" };
      }
      const route = evaluation.route;
      events.markFastPath(
        triggerId,
        route,
        route === "unowned_candidate" ? ADJUDICATION_PENDING : null,
        at,
      );
      decisionLog.record({
        workspaceIdentity: envelope.workspaceIdentity,
        triggerId,
        origin: "fast_path",
        // §3.1：owned/explicit 直通行记 routed（已路由，M12②）；candidate 记 record_only 待裁决收敛。
        disposition: route === "unowned_candidate" ? "record_only" : "routed",
        reason: reasonForRoute(route),
        createdAt: at,
      });
      db.exec("commit");
      return { triggerId, route };
    } catch (error) {
      try {
        db.exec("rollback");
      } catch {
        // 回滚失败不覆盖原始写入错误（与 control-plane-lease / applyVerdicts 同约定）。
      }
      throw error;
    }
  }

  return {
    async ingest(envelope: TriggerEnvelope): Promise<IngestResult> {
      if (envelope.taint !== true) {
        // taint 由可信出口铸造；非 true 说明信封被伪造或装配错误，响亮失败不降级（§5）。
        throw new Error("TriggerEnvelope.taint 必须为 true（出口铸造，客户端不可伪造）");
      }
      const domainKey =
        mintDomainKeyFromEnvelope(envelope) ?? UNSCOPED_THREAD_DOMAIN_KEY;
      const threadKey = mintThreadKey(envelope.workspaceIdentity, domainKey);
      const provider = envelope.provider;
      const providerMessageId = envelope.providerMessageId?.trim() || undefined;

      let triggerId: string;
      if (providerMessageId) {
        try {
          triggerId = events.insert({
            workspaceIdentity: envelope.workspaceIdentity,
            source: envelope.source,
            threadKey,
            actorKind: envelope.actor.kind,
            actorId: envelope.actor.id,
            payload: JSON.stringify(envelope.payload ?? {}),
            provider,
            providerMessageId,
            now: now(),
          });
        } catch (error) {
          if (!isUniqueConstraintError(error)) throw error;
          // 三层幂等持久层命中（裁定 3）：返回已收敛 triggerId；未收敛行（崩溃缝）重算 Fast Path。
          const existing = events.findByProviderMessageId(provider, providerMessageId);
          if (!existing) throw error;
          const converged = routeFromRow(existing);
          if (converged !== undefined) {
            return { triggerId: existing.id, route: converged };
          }
          return convergeFastPath(envelope, existing.id, threadKey);
        }
      } else {
        // 无幂等键成员（部分 provider 不回传 messageId）：每次都是新行，靠 markInboundDelivery 快速守卫。
        triggerId = events.insert({
          workspaceIdentity: envelope.workspaceIdentity,
          source: envelope.source,
          threadKey,
          actorKind: envelope.actor.kind,
          actorId: envelope.actor.id,
          payload: JSON.stringify(envelope.payload ?? {}),
          provider,
          now: now(),
        });
      }
      return convergeFastPath(envelope, triggerId, threadKey);
    },
  };
}
