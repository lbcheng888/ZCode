import type { SessionId, SessionStorePort } from "@zcode/contracts";

import type {
  ChengJobNotification,
  ChengJobNotificationLedger,
} from "./cheng-job-registry.js";

/**
 * 生产账本：`session_input` 的 `cheng_<jobId>` 行 + runtime 的 task-notification 队列。
 *
 * claim-first：`hasClaim` 命中即跳过；否则先 `saveSessionInput`（durable），成功后才调用
 * 注入的 enqueue（生产接 runtime 的 `enqueueBackgroundTaskNotification({claimPersisted:true})`）。
 * 账本缺席或写失败一律抛错，调用方不会再 enqueue——at-most-once 允许 0 投，不允许双投。
 */
export function createChengJobNotificationLedger(input: {
  sessionStore: SessionStorePort;
  sessionID: SessionId;
  enqueue: (notification: ChengJobNotification) => Promise<void>;
}): ChengJobNotificationLedger {
  const { sessionStore, sessionID, enqueue } = input;
  return {
    async hasClaim(commandId) {
      if (sessionStore.getSessionInputById === undefined) {
        throw new Error("Cheng notification ledger unavailable: session store lacks getSessionInputById");
      }
      return (await sessionStore.getSessionInputById(commandId)) !== null;
    },

    async claim(commandId, notification) {
      if (sessionStore.saveSessionInput === undefined) {
        throw new Error("Cheng notification ledger unavailable: session store lacks saveSessionInput");
      }
      await sessionStore.saveSessionInput({
        id: commandId,
        sessionID,
        kind: "backgroundNotification",
        delivery: "queue",
        payload: {
          text: notification.text,
          taskId: notification.taskId,
          originMeta: notification.originMeta,
        },
      });
    },

    async enqueue(notification) {
      await enqueue(notification);
    },
  };
}
