import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { createTestRenderer } from "@mbears/opentui-core/testing";
import { runTuiWithRenderer } from "../../tui/src/tui.js";
import { TUI_SWITCHABLE_MODES } from "../../tui/src/app-mode.js";
import type { TuiOptions } from "../../tui/src/types.js";
import { resolveExecutionState } from "@zcode/shared";
import { createTuiSubmitPrompt } from "../src/tui-prompt-handler.js";
import { createCliModeState, currentCliMode } from "../src/tui-command-state.js";
import type { RunDependencies } from "../src/cli-types.js";
import type { SendInputOptions, ZCodeAppOptions } from "@zcode/bootstrap";

async function fixture(overrides: Partial<TuiOptions> = {}) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const terminal = await createTestRenderer({
    width: 110,
    height: 32,
    targetFps: 30,
    screenMode: "alternate-screen",
    useThread: false,
  });
  terminal.renderer.waitForThemeMode = async () => "dark";
  const modes: string[] = [];
  let outcome!: Promise<number>;
  await React.act(async () => {
    outcome = runTuiWithRenderer(
      {
        noColor: true,
        locale: "en-US",
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        initialMode: "yolo",
        workspaceDirectory: "/test/workspace",
        submitPrompt: async () => ({ response: "" }),
        setMode: async (mode) => {
          modes.push(mode);
          return { mode };
        },
        ...overrides,
      },
      terminal.renderer,
    );
  });
  return {
    ...terminal,
    modes,
    async action(work: () => void | Promise<void>) {
      await React.act(async () => {
        await work();
      });
      await React.act(async () => {
        await terminal.renderOnce();
      });
    },
    async close() {
      await React.act(async () => terminal.renderer.destroy());
      await outcome;
      environment.IS_REACT_ACT_ENVIRONMENT = previous;
    },
  };
}

test("terminal Shift+Tab cycles modes with an empty or populated composer", async () => {
  const terminal = await fixture();
  try {
    await terminal.action(() => terminal.renderOnce());
    // 循环顺序以 TUI_SWITCHABLE_MODES 为准：staging 新增 guarded 并把 edit 移出 Shift+Tab 循环。
    for (const mode of TUI_SWITCHABLE_MODES) {
      await terminal.action(() => terminal.mockInput.pressTab({ shift: true }));
      assert.equal(terminal.modes.at(-1), mode);
      assert.match(
        terminal.captureCharFrame(),
        new RegExp(` ${mode[0].toUpperCase()}${mode.slice(1)} `),
      );
    }
    await terminal.action(() => terminal.mockInput.typeText("keep this draft"));
    await terminal.action(() => terminal.mockInput.pressTab({ shift: true }));
    assert.deepEqual(terminal.modes, [...TUI_SWITCHABLE_MODES, "plan"]);
    assert.match(terminal.captureCharFrame(), /keep this draft/);
  } finally {
    await terminal.close();
  }
});

test("Shift+Tab still reaches the app after the startup screen is replaced", async () => {
  const terminal = await fixture({
    loadStartupOptions: async () => ({ initialMode: "yolo" }),
  });
  try {
    await terminal.action(() => terminal.renderOnce());
    await terminal.action(() => terminal.mockInput.pressTab({ shift: true }));
    assert.deepEqual(terminal.modes, ["plan"]);
  } finally {
    await terminal.close();
  }
});

test("Shift+Tab switches mode while file suggestions are open; Tab still completes the file", async () => {
  const terminal = await fixture({
    listWorkspacePathSuggestions: async () => ({
      items: [{ path: "README.md", kind: "file" }],
      truncated: false,
    }),
  });
  try {
    await terminal.action(() => terminal.mockInput.typeText("@READ"));
    assert.match(terminal.captureCharFrame(), /README.md/);
    await terminal.action(() => terminal.mockInput.pressTab({ shift: true }));
    assert.deepEqual(terminal.modes, ["plan"]);
    assert.match(terminal.captureCharFrame(), /@READ\s/);
    assert.doesNotMatch(terminal.captureCharFrame(), /@README.md/);
    await terminal.action(() => terminal.mockInput.pressTab());
    assert.match(terminal.captureCharFrame(), /@README.md/);
    assert.deepEqual(terminal.modes, ["plan"]);
  } finally {
    await terminal.close();
  }
});

test("runtime Plan state survives Shift+Tab responses and metadata refreshes", async () => {
  let execution = resolveExecutionState({ mode: "yolo" });
  const state = createCliModeState();
  const app = {
    getMode: () => execution.mode,
    runtime: { getPlanEnabled: () => execution.planEnabled },
    setMode: async (mode: string) => {
      execution = resolveExecutionState({ mode }, execution);
      // The real facade returns the permission mode, independently of Plan.
      return { mode: execution.mode };
    },
    listModels: () => [],
    close: async () => {},
  };
  const handler = createTuiSubmitPrompt(
    {
      env: {},
      cwd: () => process.cwd(),
      skipUserConfig: true,
      loadDotenv: () => ({ keys: [], loaded: false, path: "" }),
      createZCodeApp: async () => app,
      startProcessProviderRegistryRuntime: async () => ({
        runtime: { registryService: {} },
        dispose() {},
      }),
    } as unknown as RunDependencies,
    state,
    "test",
  );
  await handler.getSessionMetadata!();
  const terminal = await fixture({ initialMode: currentCliMode(state), setMode: handler.setMode });
  try {
    await terminal.action(() => terminal.mockInput.pressTab({ shift: true }));
    assert.deepEqual(execution, { mode: "yolo", planEnabled: true });
    assert.match(terminal.captureCharFrame(), / Plan /);
    await handler.getSessionMetadata!();
    assert.equal(currentCliMode(state), "plan");
    await terminal.action(() => terminal.mockInput.pressTab({ shift: true }));
    assert.deepEqual(execution, { mode: "build", planEnabled: false });
    assert.match(terminal.captureCharFrame(), / Build /);
  } finally {
    await terminal.close();
    await handler.close!();
  }
});

test("TUI 宿主注入 super-agent options：handleCommand 延迟绑定 sendInput，缺站响亮失败", async () => {
  const sent: Array<{ text: string; options: SendInputOptions | undefined }> = [];
  let captured: ZCodeAppOptions | undefined;
  const app = {
    sessionId: "session-1",
    runtime: { getPlanEnabled: () => false },
    listModels: () => [],
    sendInput: async (text: string, options?: SendInputOptions) => {
      sent.push({ text, options });
      return { kind: "started_turn" as const, completion: Promise.resolve({}), turnId: "turn-1" };
    },
    close: async () => {},
  };
  const state = createCliModeState();
  const deps = {
    env: {},
    cwd: () => process.cwd(),
    skipUserConfig: true,
    loadDotenv: () => ({ keys: [], loaded: false, path: "" }),
    createZCodeApp: async (options?: ZCodeAppOptions) => {
      captured = options;
      return app as unknown as ReturnType<NonNullable<RunDependencies["createZCodeApp"]>>;
    },
    startProcessProviderRegistryRuntime: async () => ({
      runtime: { registryService: {} },
      dispose() {},
    }),
  } as unknown as RunDependencies;
  const handler = createTuiSubmitPrompt(deps, state, "test");
  try {
    // flag-on 的启动期缺口曾被 create-app 通用门判成「缺 options.superAgent」响亮失败；
    // 这里断言 TUI 宿主真实给出注入面（flag 关时 create-app 忽略该字段，字节兼容）。
    await handler.getSessionMetadata!();
    const superAgent = captured?.superAgent;
    assert.ok(superAgent, "TUI createApp options 必须携带 superAgent 注入面");
    assert.equal(typeof superAgent.handleCommand, "function");
    assert.equal(typeof superAgent.autoReplyGuard.admit, "function");
    assert.match(superAgent.superAgentDatabasePath ?? "", /super-agent\.sqlite$/);
    // tasks-index 是可选桥：文件存在（services 已迁移）才注入；纯 CLI 环境缺席不阻止启动。
    if (superAgent.tasksIndexDatabasePath !== undefined) {
      assert.match(superAgent.tasksIndexDatabasePath, /tasks-index\.sqlite$/);
    }

    const envelope = {
      commandId: "cmd-1",
      clientId: "super-agent-trigger",
      sessionId: "session-1",
      type: "sendText" as const,
      payload: { text: "nightly failed", requestedDelivery: "queue" },
      issuedAt: Date.now(),
    };
    const ack = await superAgent.handleCommand(envelope);
    assert.equal(ack.status, "accepted");
    assert.deepEqual(sent, [
      {
        text: "nightly failed",
        options: { inputId: "cmd-1", delivery: "auto", queueDelivery: "queue" },
      },
    ]);
    // 同进程重投按 CommandInbox duplicate 语义吸收，不重复起轮。
    assert.equal((await superAgent.handleCommand(envelope)).status, "duplicate");
    assert.equal(sent.length, 1);

    // TUI 只承载本会话：外部 sessionId 不伪造 admission。
    const external = await superAgent.handleCommand({
      ...envelope,
      commandId: "cmd-2",
      sessionId: "session-2",
    });
    assert.equal(external.status, "rejected");
    assert.equal(external.reasonCode, "tui.sessionNotHosted");

    // 事件信封：来源由 host 从 triggerId 推导，随 sendInput 交给 Core（M4 fail-closed）。
    const triggerEnvelope = {
      ...envelope,
      commandId: "cmd-trigger",
      type: "sendText" as const,
      payload: { text: "triggered", requestedDelivery: "startNow" },
      triggerId: "trigger-1",
    };
    assert.equal((await superAgent.handleCommand(triggerEnvelope)).status, "accepted");
    assert.deepEqual(sent.at(-1), {
      text: "triggered",
      options: { inputId: "cmd-trigger", delivery: "start_turn", triggerSource: "trigger" },
    });

    // 群内 IM 守卫无 botsService 状态：仅守卫适用面（群内普通消息）响亮失败。
    await assert.rejects(
      () =>
        superAgent.autoReplyGuard.admit({
          source: "im",
          payload: { chatType: "group" },
        } as never),
      /TUI 宿主缺 bots 互答守卫状态/,
    );
    // 非守卫适用面（卡片回调 / elicitation / 私聊）按 intake 合同原样放行。
    assert.equal(
      await superAgent.autoReplyGuard.admit({
        source: "im",
        payload: { chatType: "group", groupCardAction: true },
      } as never),
      true,
    );
    assert.equal(
      await superAgent.autoReplyGuard.admit({
        source: "im",
        payload: { chatType: "group", elicitation: true },
      } as never),
      true,
    );
    assert.equal(
      await superAgent.autoReplyGuard.admit({
        source: "im",
        payload: { chatType: "private" },
      } as never),
      true,
    );
  } finally {
    await handler.close!();
  }
});
