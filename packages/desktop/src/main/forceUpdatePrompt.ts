/* eslint-disable max-lines -- 强制升级提示窗口包含内联 HTML/CSS 和状态脚本，启动前不能依赖 renderer 包 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Locale } from "@zcode/shared";
import type { ForceUpdateDialogText, ForceUpdateGuardLogger } from "./forceUpdateGuard.js";
import type { ForceAutoUpdateState } from "./autoUpdater.js";

const FORCE_UPDATE_PROMPT_WIDTH = 480;
const FORCE_UPDATE_PROMPT_HEIGHT = 256;
const FORCE_UPDATE_PROMPT_COMPACT_HEIGHT = 232;

type ForceUpdatePromptAction = "auto" | "manual" | "quit";
type ForceUpdatePromptState = ForceAutoUpdateState | { kind: "idle" } | { kind: "confirm-close" };
type StartForceAutoUpdate = (
  onStateChange: (state: ForceAutoUpdateState) => void,
) => (() => void) | void;

interface ShowForceUpdatePromptOptions {
  startAutoUpdate?: StartForceAutoUpdate;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readForceUpdatePromptIcon(): string | null {
  const iconPaths = [
    process.resourcesPath ? resolve(process.resourcesPath, "icon.png") : null,
    resolve(process.cwd(), "build/icon.png"),
  ];
  for (const iconPath of iconPaths) {
    if (!iconPath) continue;
    try {
      return `data:image/png;base64,${readFileSync(iconPath).toString("base64")}`;
    } catch {
      // 打包态优先 resources/icon.png；开发态回退仓库 build/icon.png。
    }
  }
  return null;
}

function buildForceUpdatePromptMessages(locale: Locale) {
  if (locale === "zh-CN") {
    return {
      checkingTitle: "正在检查更新",
      checkingMessage: "请保持此窗口打开，ChengCode 正在查找可用更新。",
      downloadingTitle: "正在下载更新",
      downloadingVersionTitle: "正在下载更新 v{version}",
      downloadingMessage: "下载完成后会自动安装，请勿关闭应用。",
      readyTitle: "更新已下载",
      readyMessage: "ChengCode 正在准备重启并安装更新。",
      installingTitle: "正在安装更新",
      installingMessage: "ChengCode 即将重启完成安装。",
      errorTitle: "自动升级失败",
      errorMessage: "你可以重试自动升级，或改用手动升级。",
      devSkippedTitle: "调试环境无法自动升级",
      devSkippedMessage: "自动升级仅在打包后的应用中可用，请使用手动升级或打包应用验证。",
      confirmCloseTitle: "自动升级正在进行",
      confirmCloseMessage: "关闭窗口会中断当前自动升级流程，旧版本仍然无法进入主界面。你可以继续等待，或确认关闭并退出。",
      confirmCloseButton: "确认关闭",
      continueUpdateButton: "继续更新",
      retryButton: "重试自动升级",
      checkingButton: "检查中...",
      downloadingButton: "下载中...",
      installingButton: "安装中...",
    };
  }

  return {
    checkingTitle: "Checking for updates",
    checkingMessage: "Keep this window open while ChengCode checks for updates.",
    downloadingTitle: "Downloading update",
    downloadingVersionTitle: "Downloading update v{version}",
    downloadingMessage: "ChengCode will install the update automatically after download.",
    readyTitle: "Update downloaded",
    readyMessage: "ChengCode is preparing to restart and install the update.",
    installingTitle: "Installing update",
    installingMessage: "ChengCode will restart to finish installing the update.",
    errorTitle: "Auto update failed",
    errorMessage: "You can retry auto update or use manual update.",
    devSkippedTitle: "Auto update unavailable in development",
    devSkippedMessage: "Auto update is only available in packaged apps. Use manual update or test a packaged build.",
    confirmCloseTitle: "Auto update in progress",
    confirmCloseMessage: "Closing this window will stop the current auto update flow, and this old version still cannot open the main app. You can keep waiting or close and quit.",
    confirmCloseButton: "Close anyway",
    continueUpdateButton: "Continue update",
    retryButton: "Retry auto update",
    checkingButton: "Checking...",
    downloadingButton: "Downloading...",
    installingButton: "Installing...",
  };
}

function renderForceUpdatePromptHtml(text: ForceUpdateDialogText, locale: Locale): string {
  const icon = readForceUpdatePromptIcon();
  const messages = buildForceUpdatePromptMessages(locale);
  const detailLines = text.detail
    .split("\n")
    .map((line) => `<div class="version-row">${escapeHtml(line)}</div>`)
    .join("");
  const stateMessages = JSON.stringify(messages);
  const initialState = JSON.stringify({
    title: text.title,
    message: text.message,
    detailHtml: detailLines,
    autoButton: text.autoUpdateButton,
    manualButton: text.manualUpdateButton,
    quitButton: text.quitButton,
  });

  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
  <title>${escapeHtml(text.title)}</title>
    <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f8f8f8;
      color: #0d0d0d;
      user-select: none;
    }
    .window {
      width: 100vw;
      height: 100vh;
      padding: 0;
      background: #f8f8f8;
      display: flex;
    }
    /* Bugfix: 强更截图范围就是完整 BrowserWindow；外层留白加内层圆角会把宿主底色显示成黑框。 */
    .panel {
      width: 100%;
      height: 100%;
      min-height: 0;
      background: #ffffff;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .titlebar {
      height: 36px;
      padding: 0 48px 0 14px;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      position: relative;
      -webkit-app-region: drag;
      border-bottom: 1px solid rgba(13, 13, 13, 0.1);
      background: #f0f0f0;
    }
    .brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .brand-icon {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      background: #ebf4ff;
      border: 1px solid rgba(13, 13, 13, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      color: #0b7fff;
      font-size: 12px;
      font-weight: 600;
    }
    .brand-icon img { width: 100%; height: 100%; border-radius: 6px; }
    .brand-icon svg { width: 100%; height: 100%; }
    .brand-title { font-size: 13px; font-weight: 500; color: #0d0d0d; }
    .close {
      position: absolute;
      right: 0;
      top: 0;
      width: 46px;
      height: 36px;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      color: rgba(13, 13, 13, 0.62);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0;
      line-height: 0;
      cursor: pointer;
      -webkit-app-region: no-drag;
    }
    /* Bugfix: 字体字符 × 的字形基线会让视觉中心偏移，改用两条线保证和主窗口关闭按钮一致居中。 */
    .close::before,
    .close::after {
      content: "";
      position: absolute;
      width: 15px;
      height: 2px;
      border-radius: 999px;
      background: currentColor;
    }
    .close::before { transform: rotate(45deg); }
    .close::after { transform: rotate(-45deg); }
    .close:hover { background: #f8f8f8; color: #0d0d0d; }
    .content {
      padding: 18px 20px 20px;
      display: flex;
      flex: 1;
      flex-direction: column;
      gap: 14px;
    }
    .hero { display: flex; gap: 12px; align-items: flex-start; }
    .status-icon {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: color-mix(in oklab, #0b7fff 12%, transparent);
      border: 1px solid rgba(13, 13, 13, 0.1);
      color: #0b7fff;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }
    .status-icon svg { width: 20px; height: 20px; }
    h1 { margin: 0; font-size: 15px; line-height: 1.45; font-weight: 600; color: #0d0d0d; }
    .message { margin: 6px 0 0; color: rgba(13, 13, 13, 0.62); font-size: 13px; line-height: 1.6; }
    .version-card {
      border: 1px solid rgba(13, 13, 13, 0.1);
      background: #f0f0f0;
      border-radius: 12px;
      padding: 12px 14px;
      color: #0d0d0d;
      font-size: 13px;
      line-height: 1.7;
    }
    .version-card.hidden { display: none; }
    .version-row { white-space: pre-wrap; }
    .progress { display: none; gap: 8px; flex-direction: column; }
    .progress.visible { display: flex; }
    .progress-track { height: 6px; border-radius: 999px; background: rgba(13, 13, 13, 0.08); overflow: hidden; }
    .progress-bar { width: 0%; height: 100%; border-radius: inherit; background: #0b7fff; transition: width 160ms ease; }
    .progress-text { color: rgba(13, 13, 13, 0.62); font-size: 12px; }
    .actions {
      margin-top: auto;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      -webkit-app-region: no-drag;
    }
    button {
      min-width: 88px;
      height: 28px;
      border: 1px solid rgba(13, 13, 13, 0.1);
      background: #ffffff;
      color: #0d0d0d;
      border-radius: 6px;
      padding: 0 12px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    button:hover { background: #f8f8f8; border-color: rgba(13, 13, 13, 0.15); }
    button:disabled { cursor: default; opacity: 0.58; }
    button.primary { border-color: transparent; background: #000000; color: #ffffff; }
    button.primary:hover { background: rgba(0, 0, 0, 0.82); }
    button.secondary { background: #e6e6e6; }
    button.secondary:hover { background: #f0f0f0; }
    @media (prefers-color-scheme: dark) {
      body { background: #2b2b2b; color: #f8f8f8; }
      .window { background: #2b2b2b; }
      .panel { background: #2b2b2b; border-color: transparent; }
      .titlebar { background: #202020; border-bottom-color: rgba(255, 255, 255, 0.1); }
      .brand-title, h1 { color: #f8f8f8; }
      .brand-icon { background: #001d3d; border-color: rgba(255, 255, 255, 0.1); color: #80beff; }
      .close { color: rgba(248, 248, 248, 0.64); }
      .close:hover { background: #363636; border-color: rgba(255, 255, 255, 0.15); color: #f8f8f8; }
      .message { color: rgba(248, 248, 248, 0.64); }
      .status-icon { background: color-mix(in oklab, #4099ff 14%, transparent); border-color: rgba(255, 255, 255, 0.1); color: #80beff; }
      .version-card { border-color: rgba(255, 255, 255, 0.1); background: #202020; color: #f8f8f8; }
      .progress-track { background: rgba(255, 255, 255, 0.1); }
      .progress-bar { background: #80beff; }
      .progress-text { color: rgba(248, 248, 248, 0.64); }
      button { border-color: rgba(255, 255, 255, 0.1); background: #2b2b2b; color: #f8f8f8; }
      button:hover { background: #363636; border-color: rgba(255, 255, 255, 0.15); }
      button.primary { border-color: transparent; background: #ffffff; color: #161616; }
      button.primary:hover { background: rgba(255, 255, 255, 0.82); }
      button.secondary { background: #363636; }
      button.secondary:hover { background: #2b2b2b; }
    }
    @media (max-width: 560px) {
      .window { padding: 0; }
      .content { padding: 16px; }
      .actions { flex-wrap: wrap; }
      button { min-width: 0; flex: 1 1 0; }
    }
  </style>
</head>
<body>
  <div class="window">
    <main class="panel" role="dialog" aria-modal="true" aria-labelledby="title">
      <header class="titlebar">
        <div class="brand">
          <div class="brand-icon">${icon ? `<img src="${icon}" alt="" />` : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="cheng-force-update-gradient" x1="10" y1="6" x2="104" y2="110" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#F3EEFF" />
              <stop offset=".45" stop-color="#B59AFF" />
              <stop offset="1" stop-color="#6E4BF2" />
            </linearGradient>
          </defs>
          <rect width="100" height="100" rx="22" fill="#0B0910" />
          <g transform="translate(11.5 6) scale(.78)">
            <path fill="url(#cheng-force-update-gradient)" fill-rule="evenodd" d="M24.66 41.85A38.76 44.18 0 0 0 91.75 85.34C92.73 80.94 93.06 75.92 91.95 72.79C90.49 69.44 85.8 67.87 82.23 69.44C82.68 72.57 83.12 75.92 83.24 79.38A28.37 33.79 0 1 1 80.06 36.11C82.68 37.38 88.04 38.16 93.06 37.49C94.96 37.05 95.41 33.69 95.19 31.46L96.75 28.11C93.62 28.33 89.15 27.66 85.8 25.65C83.57 24.09 81.33 21.18 78.21 18.95C77.09 15.6 75.75 12.25 70.16 10.57C63.46 8.9 52.29 8.34 43.36 10.57C36.65 12.25 31.07 16.72 27.94 20.63C24.93 24.31 19.9 26.99 14.31 26.32C10.96 25.65 9.29 22.86 8.51 19.17C5.38 20.63 2.25 25.65 2.25 31.24C2.25 37.38 7.61 41.85 14.31 42.41C18.22 42.63 21.58 42.18 24.66 41.85ZM26.43 37.91L27.43 35.77L28.54 33.69L29.75 31.68L31.06 29.75L32.48 27.91L33.99 26.15L35.6 24.5L37.3 22.96L39.08 21.53L40.93 20.23L42.86 19.06L44.85 18.01L46.89 17.11L48.98 16.35L51.1 15.74L53.26 15.28L55.43 14.96L57.62 14.8L59.8 14.78L61.98 14.92L64.14 15.2L66.28 15.63L68.39 16.2L70.45 16.9L72.47 17.74L74.44 18.7L76.35 19.79L78.2 20.99L78.28 20.85L76.36 19.76L74.4 18.8L72.4 17.96L70.36 17.25L68.28 16.67L66.19 16.22L64.07 15.9L61.94 15.71L59.81 15.66L57.67 15.73L55.55 15.95L53.43 16.29L51.34 16.77L49.27 17.37L47.23 18.11L45.24 18.97L43.29 19.95L41.38 21.06L39.54 22.28L37.75 23.61L36.03 25.06L34.39 26.61L32.82 28.25L31.33 30L29.93 31.84L28.62 33.76L27.41 35.76L26.29 37.83ZM88.43 28.62L88.31 28.77L88.04 28.88L87.63 28.93L87.11 28.93L86.51 28.88L85.89 28.77L85.27 28.61L84.7 28.42L84.23 28.21L83.87 27.99L83.67 27.79L83.62 27.6L83.74 27.45L84.01 27.34L84.42 27.28L84.94 27.29L85.54 27.34L86.17 27.45L86.78 27.61L87.35 27.8L87.82 28.01L88.18 28.22L88.38 28.43Z" />
            <path fill="none" stroke="url(#cheng-force-update-gradient)" stroke-width="6.5" d="M46.6 49.53A17 17 0 1 1 46.6 70.47" />
            <circle cx="60" cy="60" r="5.5" fill="url(#cheng-force-update-gradient)" />
          </g>
        </svg>`}</div>
          <div class="brand-title">ChengCode</div>
        </div>
        <button class="close" type="button" data-action="quit" aria-label="${escapeHtml(text.quitButton)}">×</button>
      </header>
      <section class="content">
        <div class="hero">
          <div class="status-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
          </div>
          <div>
            <h1 id="title" data-role="status-title">${escapeHtml(text.title)}</h1>
            <p class="message" data-role="status-message">${escapeHtml(text.message)}</p>
          </div>
        </div>
        <section class="version-card" data-role="detail">${detailLines}</section>
        <section class="progress" data-role="progress" aria-live="polite">
          <div class="progress-track"><div class="progress-bar" data-role="progress-bar"></div></div>
          <div class="progress-text" data-role="progress-text"></div>
        </section>
        <div class="actions">
          <button type="button" data-action="quit" data-role="quit-button">${escapeHtml(text.quitButton)}</button>
          <button type="button" class="secondary" data-action="manual" data-role="manual-button">${escapeHtml(text.manualUpdateButton)}</button>
          <button type="button" class="primary" data-action="auto" data-role="auto-button">${escapeHtml(text.autoUpdateButton)}</button>
        </div>
      </section>
    </main>
  </div>
  <script>
    const messages = ${stateMessages};
    const initialState = ${initialState};
    let currentState = { kind: 'idle' };
    let previousAutoState = null;
    const elements = {
      title: document.querySelector('[data-role="status-title"]'),
      message: document.querySelector('[data-role="status-message"]'),
      detail: document.querySelector('[data-role="detail"]'),
      progress: document.querySelector('[data-role="progress"]'),
      progressBar: document.querySelector('[data-role="progress-bar"]'),
      progressText: document.querySelector('[data-role="progress-text"]'),
      autoButton: document.querySelector('[data-role="auto-button"]'),
      manualButton: document.querySelector('[data-role="manual-button"]'),
      quitButton: document.querySelector('[data-role="quit-button"]'),
    };
    function resizePromptHeight(height) {
      if (window.__setForceUpdatePromptHeight) {
        window.__setForceUpdatePromptHeight(height);
      }
    }
    function setDetailVisible(visible) {
      elements.detail.classList.toggle('hidden', !visible);
      if (visible) {
        elements.detail.innerHTML = initialState.detailHtml;
      }
    }
    function formatMessage(template, values) {
      return String(template).replace(/{(\\w+)}/g, (_, key) => values && values[key] ? values[key] : '');
    }
    function setProgress(percent, text) {
      const visible = typeof percent === 'number' || Boolean(text);
      elements.progress.classList.toggle('visible', visible);
      elements.progressBar.style.width = typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) + '%' : '0%';
      elements.progressText.textContent = text || '';
    }
    function setButtons(autoText, autoDisabled) {
      elements.autoButton.textContent = autoText;
      elements.autoButton.disabled = Boolean(autoDisabled);
      elements.manualButton.disabled = false;
      elements.quitButton.disabled = false;
    }
    function isActiveAutoState(kind) {
      return kind === 'checking' || kind === 'downloading' || kind === 'ready' || kind === 'installing';
    }
    function showCloseConfirmation() {
      // Bugfix: 自动升级会禁用主按钮，但关闭窗口仍应给用户二次确认，避免误关中断下载。
      resizePromptHeight(${FORCE_UPDATE_PROMPT_HEIGHT});
      previousAutoState = isActiveAutoState(currentState.kind) ? currentState : previousAutoState;
      currentState = { kind: 'confirm-close' };
      elements.title.textContent = messages.confirmCloseTitle;
      elements.message.textContent = messages.confirmCloseMessage;
      setDetailVisible(true);
      setProgress(undefined, '');
      elements.quitButton.textContent = messages.continueUpdateButton;
      elements.manualButton.textContent = initialState.manualButton;
      elements.autoButton.textContent = messages.confirmCloseButton;
      elements.quitButton.disabled = false;
      elements.manualButton.disabled = false;
      elements.autoButton.disabled = false;
    }
    window.__setForceUpdateState = function (state) {
      const kind = state && state.kind;
      if (kind !== 'confirm-close') {
        currentState = state || { kind: 'idle' };
      }
      if (kind === 'checking') {
        resizePromptHeight(${FORCE_UPDATE_PROMPT_HEIGHT});
        elements.title.textContent = messages.checkingTitle;
        elements.message.textContent = messages.checkingMessage;
        setDetailVisible(true);
        setProgress(undefined, '');
        setButtons(messages.checkingButton, true);
        return;
      }
      if (kind === 'downloading') {
        const progress = Number.parseFloat(state.progress || '');
        const hasProgress = Number.isFinite(progress);
        const version = state.version || '';
        resizePromptHeight(${FORCE_UPDATE_PROMPT_COMPACT_HEIGHT});
        elements.title.textContent = version ? formatMessage(messages.downloadingVersionTitle, { version }) : messages.downloadingTitle;
        elements.message.textContent = messages.downloadingMessage;
        setDetailVisible(false);
        setProgress(hasProgress ? progress : undefined, hasProgress ? progress.toFixed(0) + '%' : '');
        setButtons(hasProgress ? messages.downloadingButton + ' ' + progress.toFixed(0) + '%' : messages.downloadingButton, true);
        return;
      }
      if (kind === 'ready' || kind === 'installing') {
        resizePromptHeight(${FORCE_UPDATE_PROMPT_COMPACT_HEIGHT});
        elements.title.textContent = kind === 'ready' ? messages.readyTitle : messages.installingTitle;
        elements.message.textContent = kind === 'ready' ? messages.readyMessage : messages.installingMessage;
        setDetailVisible(false);
        setProgress(100, '100%');
        setButtons(messages.installingButton, true);
        return;
      }
      if (kind === 'error' || kind === 'dev-skipped') {
        resizePromptHeight(${FORCE_UPDATE_PROMPT_HEIGHT});
        elements.title.textContent = kind === 'dev-skipped' ? messages.devSkippedTitle : messages.errorTitle;
        elements.message.textContent = state.message || (kind === 'dev-skipped' ? messages.devSkippedMessage : messages.errorMessage);
        setDetailVisible(true);
        setProgress(undefined, '');
        setButtons(messages.retryButton, false);
        return;
      }
      resizePromptHeight(${FORCE_UPDATE_PROMPT_HEIGHT});
      elements.title.textContent = initialState.title;
      elements.message.textContent = initialState.message;
      setDetailVisible(true);
      setProgress(undefined, '');
      setButtons(initialState.autoButton, false);
      elements.manualButton.textContent = initialState.manualButton;
      elements.quitButton.textContent = initialState.quitButton;
    };
    window.__confirmForceUpdateClose = function () {
      showCloseConfirmation();
    };
    document.querySelectorAll('button[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        let action = button.dataset.action;
        if ((action === 'quit' || action === 'manual') && isActiveAutoState(currentState.kind)) {
          showCloseConfirmation();
          return;
        }
        if (currentState.kind === 'confirm-close') {
          if (action === 'quit') {
            window.__setForceUpdateState(previousAutoState || { kind: 'checking' });
            return;
          }
          if (action === 'auto') {
            action = 'quit';
          }
        }
        document.title = 'force-update:' + action;
        setTimeout(() => {
          if (document.title === 'force-update:' + action) {
            document.title = initialState.title;
          }
        }, 0);
      });
    });
  </script>
</body>
</html>`;
}

export async function showForceUpdatePrompt(
  text: ForceUpdateDialogText,
  locale: Locale,
  logger: ForceUpdateGuardLogger,
  options: ShowForceUpdatePromptOptions = {},
): Promise<ForceUpdatePromptAction> {
  const { BrowserWindow, nativeTheme } = await import("electron");
  const parentWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? undefined;
  return new Promise<ForceUpdatePromptAction>((resolvePrompt) => {
    let resolved = false;
    let shown = false;
    let autoUpdateDispose: (() => void) | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const win = new BrowserWindow({
      width: FORCE_UPDATE_PROMPT_WIDTH,
      height: FORCE_UPDATE_PROMPT_HEIGHT,
      minWidth: FORCE_UPDATE_PROMPT_WIDTH,
      minHeight: FORCE_UPDATE_PROMPT_HEIGHT,
      parent: parentWindow,
      modal: Boolean(parentWindow),
      frame: false,
      transparent: false,
      hasShadow: true,
      roundedCorners: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      alwaysOnTop: !parentWindow,
      center: true,
      focusable: true,
      skipTaskbar: false,
      paintWhenInitiallyHidden: true,
      title: text.title,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#2b2b2b" : "#f8f8f8",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    const updatePromptState = (state: ForceUpdatePromptState) => {
      if (win.isDestroyed()) {
        return;
      }
      const script = `window.__setForceUpdateState?.(${JSON.stringify(state)})`;
      void win.webContents.executeJavaScript(script).catch((error) => {
        logger.warn("[force-update] 更新强制升级提示状态失败", { error });
      });
    };

    const updatePromptHeight = (height: number) => {
      if (win.isDestroyed()) {
        return;
      }
      // 下载态隐藏版本说明后需要收回窗口高度，避免出现大片空白；确认关闭/错误态再恢复默认高度。
      win.setSize(FORCE_UPDATE_PROMPT_WIDTH, height);
      win.center();
    };

    const resolveOnce = (action: ForceUpdatePromptAction, closeWindow: boolean) => {
      if (resolved && !closeWindow) {
        return;
      }
      if (!resolved) {
        resolved = true;
        resolvePrompt(action);
      }
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }
      if (closeWindow && !win.isDestroyed()) {
        win.close();
      }
    };

    const startAutoUpdate = () => {
      if (autoUpdateDispose) {
        autoUpdateDispose();
      }
      logger.info("[force-update] 用户选择自动升级");
      updatePromptState({ kind: "checking" });
      autoUpdateDispose = options.startAutoUpdate?.((state) => updatePromptState(state)) ?? undefined;
    };

    const showPromptWindow = (source: string) => {
      if (win.isDestroyed()) {
        return;
      }
      if (!shown) {
        shown = true;
        logger.info(`[force-update] 显示强制升级提示窗口 source=${source}`);
      }
      win.show();
      win.focus();
      // 启动前没有主窗口时，原生消息框在部分开发环境不可见；显式置顶保证用户能看到强制升级提示。
      if (!parentWindow) {
        win.setAlwaysOnTop(true, "modal-panel");
      }
    };

    win.on("closed", () => {
      autoUpdateDispose?.();
      if (!resolved) {
        // 自动升级是异步流程，用户关闭保留中的强更窗口时仍要把最终退出动作交还给 guard。
        resolveOnce("quit", false);
      }
    });
    win.webContents.on("page-title-updated", (event, title) => {
      if (title.startsWith("force-update-height:")) {
        event.preventDefault();
        const height = Number.parseInt(title.slice("force-update-height:".length), 10);
        if (Number.isFinite(height)) {
          updatePromptHeight(height);
        }
        return;
      }
      if (!title.startsWith("force-update:")) {
        return;
      }
      event.preventDefault();
      const action = title.slice("force-update:".length);
      if (action === "auto") {
        startAutoUpdate();
        return;
      }
      autoUpdateDispose?.();
      resolveOnce(action === "manual" ? "manual" : "quit", true);
    });
    win.once("ready-to-show", () => showPromptWindow("ready-to-show"));
    win.webContents.once("did-finish-load", () => {
      void win.webContents
        .executeJavaScript(
          `window.__setForceUpdatePromptHeight = (height) => { document.title = 'force-update-height:' + height; };`,
        )
        .catch((error) => {
          logger.warn("[force-update] 初始化强制升级窗口高度桥失败", { error });
        });
      showPromptWindow("did-finish-load");
    });
    win.webContents.once("did-fail-load", (_event, errorCode, errorDescription) => {
      logger.warn("[force-update] 强制升级提示窗口加载失败", { errorCode, errorDescription });
      showPromptWindow("did-fail-load");
    });
    fallbackTimer = setTimeout(() => showPromptWindow("timeout"), 1000);
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderForceUpdatePromptHtml(text, locale))}`);
  });
}
