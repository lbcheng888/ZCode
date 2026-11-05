/**
 * B-SPEC §3.3 createTask 幂等绑定的真实文件存储：往返、缺失、损坏/版本不符必须响亮失败。
 * 不重建损坏文件——重建会把幂等事实清零，让同一 trigger 重投建出第二个会话。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileBotTriggerTaskBindingStore } from "../src/bots/botTriggerTaskBindings.js";

const WORKSPACE_IDENTITY = "remote:server:test-owner:/tmp/workspace";
const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-bot-bindings-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function binding(threadKey: string, sessionId: string) {
  return { workspaceIdentity: WORKSPACE_IDENTITY, threadKey, sessionId, createdAt: 1 };
}

describe("FileBotTriggerTaskBindingStore", () => {
  it("缺失文件 → 空表；set/get 往返且新实例可读", async () => {
    const path = join(await makeRoot(), "bindings.json");
    const store = new FileBotTriggerTaskBindingStore(path);
    await expect(store.get("trigger-1")).resolves.toBeUndefined();
    await store.set("trigger-1", binding("bot:bot-1+user-1", "task-1"));
    await expect(store.get("trigger-1")).resolves.toEqual(
      binding("bot:bot-1+user-1", "task-1"),
    );
    const reopened = new FileBotTriggerTaskBindingStore(path);
    await expect(reopened.get("trigger-1")).resolves.toEqual(
      binding("bot:bot-1+user-1", "task-1"),
    );
  });

  it("损坏 JSON → 直接抛错，不重建空表", async () => {
    const path = join(await makeRoot(), "bindings.json");
    await writeFile(path, "{not json", "utf8");
    const store = new FileBotTriggerTaskBindingStore(path);
    await expect(store.get("trigger-1")).rejects.toThrow();
  });

  it("版本不符 → 抛错，不静默重置幂等事实", async () => {
    const path = join(await makeRoot(), "bindings.json");
    await writeFile(path, JSON.stringify({ version: 2, bindings: {} }), "utf8");
    const store = new FileBotTriggerTaskBindingStore(path);
    await expect(store.get("trigger-1")).rejects.toThrow();
  });

  it("写入后文件内容仍是 version 1 严格形状", async () => {
    const path = join(await makeRoot(), "bindings.json");
    const store = new FileBotTriggerTaskBindingStore(path);
    await store.set("trigger-1", binding("bot:bot-1+user-1", "task-1"));
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      version: number;
      bindings: Record<string, unknown>;
    };
    expect(raw.version).toBe(1);
    expect(raw.bindings["trigger-1"]).toEqual(binding("bot:bot-1+user-1", "task-1"));
  });
});
