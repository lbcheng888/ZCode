/**
 * super-agent-adjudication 标准调用示例：组合根拿到域库句柄与四个注入端口后，
 * 按「leader 启动 → intake 通知 → 驱动器攒批 → 失锁停止」的最常见顺序调用。
 * agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import {
  createAdjudicationDriver,
  type AdjudicationDeliveryPort,
  type AdjudicationMandatePort,
  type AdjudicationModelSessionPort,
} from "./index.js";
import type { AdjudicationDatabaseHandle } from "./contract.js";

export async function exampleSuperAgentAdjudication(
  db: AdjudicationDatabaseHandle,
  session: AdjudicationModelSessionPort,
  delivery: AdjudicationDeliveryPort,
  mandate: AdjudicationMandatePort,
  onError: (error: unknown, context: string) => void,
): Promise<void> {
  const driver = createAdjudicationDriver({ db, session, delivery, mandate, onError });

  // 1. 获得 leader 资格后启动：定时评估点 + 启动补扫 pending workspace。
  driver.start();

  // 2. intake 路由 unowned_candidate 后通知（行缺失抛错；已收敛幂等忽略；
  //    同步返回，永不等待模型）。
  driver.notifyCandidate("6f1d2c3a-0000-7000-8000-000000000001");

  // 3. 唤醒三选一（backlog≥8 / 最老≥60s / 5min 评估点）自动攒批；也可手动跑：
  const outcome = await driver.runBatch("remote:server:owner:/tmp/workspace");
  if (outcome.status === "applied") {
    // 已交付 delivery 端口（trigger.applyVerdicts）：accept/record-only →
    // would-accept 卡片，reject → decision_log only。
  }

  // 4. 失去 leader：停止评估点与全部定时器、销毁在窗短命会话（在途批自然收尾）。
  driver.stop();
}
