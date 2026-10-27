// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { LexicalChatInput } from "@/LexicalChatInput.js";

// 生效表切片由这里固定，避免依赖 Settings/Service 装配；平台钉成非 Apple，
// CmdOrCtrl 在该平台等价于 Ctrl（与真实 Windows/Linux 分发一致）。
vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  useEffectiveShortcutBindings: () => ({
    composerSend: ["Enter"],
    composerSendNow: ["CmdOrCtrl+s"],
    composerInsertNewline: ["Shift+Enter"],
  }),
}));
vi.mock("@/lib/keyboardShortcuts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/keyboardShortcuts.js")>()),
  isAppleKeyboardPlatform: () => false,
}));
vi.mock("@/v4/activeTaskProvider.js", () => ({
  useChatViewActiveTaskProvider: () => undefined,
}));
vi.mock("@/hooks/useSubagents.js", () => ({
  useSubagents: () => ({ agents: [], loading: false, error: null }),
}));
vi.mock("@/hooks/useSkills.js", () => ({
  useSkills: () => ({ skills: [], loading: false, error: null }),
}));
vi.mock("@/hooks/useSlashCommands.js", () => ({
  useSlashCommands: () => [],
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  cleanup();
  if (root) {
    await act(() => root!.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

function renderInput(options: {
  onImmediateSubmit?: (text: string) => boolean;
  submitDisabled?: boolean;
}): {
  editable: HTMLElement;
  onSubmit: (text: string) => boolean;
  onImmediateSubmit: (text: string) => boolean;
} {
  const onSubmit = vi.fn(() => false);
  const onImmediateSubmit = vi.fn(() => false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(LexicalChatInput, {
          workspacePath: "/workspace",
          taskId: null,
          onSubmit,
          ...(options.onImmediateSubmit ? { onImmediateSubmit: options.onImmediateSubmit } : {}),
          submitDisabled: options.submitDisabled,
          allowSubmitWhenEmpty: true,
          enableMentionPanel: false,
          inputTestId: "lexical-send-now-input",
        }),
      ),
    );
  });
  const editable = container.querySelector<HTMLElement>(
    '[data-testid="lexical-send-now-input"]',
  );
  if (!editable) {
    throw new Error("Lexical 编辑器根节点未挂载");
  }
  return { editable, onSubmit, onImmediateSubmit };
}

function pressSendNow(editable: HTMLElement): boolean {
  // fireEvent 返回 false 表示事件被 preventDefault。
  return fireEvent.keyDown(editable, { key: "s", code: "KeyS", ctrlKey: true });
}

describe("Lexical composerSendNow 分发", () => {
  it("root keydown 命中 CmdOrCtrl+S 时调用 onImmediateSubmit 并吞掉按键", () => {
    const onImmediateSubmit = vi.fn(() => false);
    const { editable, onSubmit } = renderInput({ onImmediateSubmit });

    const notPrevented = pressSendNow(editable);

    expect(onImmediateSubmit).toHaveBeenCalledTimes(1);
    expect(onImmediateSubmit).toHaveBeenCalledWith("");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(notPrevented).toBe(false);
  });

  it("没有 onImmediateSubmit 时只消费按键，不回退成普通发送", () => {
    const { editable, onSubmit } = renderInput({});

    const notPrevented = pressSendNow(editable);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(notPrevented).toBe(false);
  });

  it("submitDisabled 时仍 preventDefault，Cmd+S 不落到浏览器保存", () => {
    const onImmediateSubmit = vi.fn(() => false);
    const { editable, onSubmit } = renderInput({ onImmediateSubmit, submitDisabled: true });

    const notPrevented = pressSendNow(editable);

    expect(onImmediateSubmit).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(notPrevented).toBe(false);
  });
});
