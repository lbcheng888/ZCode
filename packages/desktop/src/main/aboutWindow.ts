interface CustomAboutDialogHtmlInput {
  applicationName: string;
  appVersion: string;
  copyright: string;
  optimizationLine: string;
  versionLabel: string;
  okButtonLabel: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createCustomAboutDialogHtml(input: CustomAboutDialogHtmlInput): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    />
    <title>${escapeHtml(input.applicationName)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        --startup-page-bg: #f4f4f5;
        --about-primary: #0a0a0a;
        --about-primary-foreground: #fafafa;
        --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: var(--startup-page-bg);
      }

      body {
        display: grid;
        place-items: center;
        padding: 0;
        user-select: none;
      }

      .about-window {
        width: 100%;
        max-width: 256px;
        height: 280px;
        display: grid;
        place-items: stretch;
        padding: 0;
        background: transparent;
      }

      .about-card {
        width: 100%;
        height: 100%;
        padding: 22px 15px 14px;
        display: flex;
        flex-direction: column;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #1d1d1f;
        box-shadow: none;
        -webkit-app-region: drag;
      }

      .content {
        width: 100%;
        max-width: 222px;
        margin: 0 auto;
        flex: 1;
        min-height: 0;
      }

      .app-icon {
        width: 52px;
        height: 52px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 21%;
        box-shadow: 0 10px 13px -3px rgb(0 0 0 / 0.2), 0 4px 5px -3px rgb(0 0 0 / 0.2);
      }

      .app-logo {
        width: 100%;
        height: 100%;
        display: block;
      }

      .title {
        margin: 20px 0 0;
        font-size: 13.5px;
        line-height: 1.18;
        font-weight: 700;
        letter-spacing: 0;
      }

      .meta {
        margin-top: 28px;
        display: flex;
        flex-direction: column;
        gap: 17px;
        font-size: 13px;
        line-height: 1.2;
        font-weight: 400;
        letter-spacing: 0;
        color: #303033;
      }


      .ok-button {
        width: 100%;
        height: 36px;
        border: 0;
        border-radius: 18px;
        background: var(--about-primary);
        color: var(--about-primary-foreground);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0;
        outline: none;
        cursor: default;
        -webkit-app-region: no-drag;
      }

      .ok-button:active {
        background: var(--about-primary-active);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --startup-page-bg: #171717;
          --about-primary: #fafafa;
          --about-primary-foreground: #0a0a0a;
          --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
        }

        .about-card {
          color: #e8e8e8;
        }

        .meta {
          color: #e2e2e2;
        }
      }
    </style>
  </head>
  <body>
    <main class="about-window" aria-label="${escapeHtml(input.applicationName)} About Window">
      <section class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class="content">
          <div class="app-icon" aria-hidden="true">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="100"
              height="100"
              viewBox="0 0 100 100"
              class="app-logo"
              focusable="false"
            >
              <defs>
                <linearGradient
                  id="cheng-about-gradient"
                  x1="10"
                  y1="6"
                  x2="104"
                  y2="110"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop offset="0" stop-color="#F3EEFF" />
                  <stop offset=".45" stop-color="#B59AFF" />
                  <stop offset="1" stop-color="#6E4BF2" />
                </linearGradient>
              </defs>
              <rect width="100" height="100" rx="22" fill="#0B0910" />
              <g transform="translate(11.5 6) scale(.78)">
                <path fill="url(#cheng-about-gradient)" fill-rule="evenodd" d="M24.66 41.85A38.76 44.18 0 0 0 91.75 85.34C92.73 80.94 93.06 75.92 91.95 72.79C90.49 69.44 85.8 67.87 82.23 69.44C82.68 72.57 83.12 75.92 83.24 79.38A28.37 33.79 0 1 1 80.06 36.11C82.68 37.38 88.04 38.16 93.06 37.49C94.96 37.05 95.41 33.69 95.19 31.46L96.75 28.11C93.62 28.33 89.15 27.66 85.8 25.65C83.57 24.09 81.33 21.18 78.21 18.95C77.09 15.6 75.75 12.25 70.16 10.57C63.46 8.9 52.29 8.34 43.36 10.57C36.65 12.25 31.07 16.72 27.94 20.63C24.93 24.31 19.9 26.99 14.31 26.32C10.96 25.65 9.29 22.86 8.51 19.17C5.38 20.63 2.25 25.65 2.25 31.24C2.25 37.38 7.61 41.85 14.31 42.41C18.22 42.63 21.58 42.18 24.66 41.85ZM26.43 37.91L27.43 35.77L28.54 33.69L29.75 31.68L31.06 29.75L32.48 27.91L33.99 26.15L35.6 24.5L37.3 22.96L39.08 21.53L40.93 20.23L42.86 19.06L44.85 18.01L46.89 17.11L48.98 16.35L51.1 15.74L53.26 15.28L55.43 14.96L57.62 14.8L59.8 14.78L61.98 14.92L64.14 15.2L66.28 15.63L68.39 16.2L70.45 16.9L72.47 17.74L74.44 18.7L76.35 19.79L78.2 20.99L78.28 20.85L76.36 19.76L74.4 18.8L72.4 17.96L70.36 17.25L68.28 16.67L66.19 16.22L64.07 15.9L61.94 15.71L59.81 15.66L57.67 15.73L55.55 15.95L53.43 16.29L51.34 16.77L49.27 17.37L47.23 18.11L45.24 18.97L43.29 19.95L41.38 21.06L39.54 22.28L37.75 23.61L36.03 25.06L34.39 26.61L32.82 28.25L31.33 30L29.93 31.84L28.62 33.76L27.41 35.76L26.29 37.83ZM88.43 28.62L88.31 28.77L88.04 28.88L87.63 28.93L87.11 28.93L86.51 28.88L85.89 28.77L85.27 28.61L84.7 28.42L84.23 28.21L83.87 27.99L83.67 27.79L83.62 27.6L83.74 27.45L84.01 27.34L84.42 27.28L84.94 27.29L85.54 27.34L86.17 27.45L86.78 27.61L87.35 27.8L87.82 28.01L88.18 28.22L88.38 28.43Z" />
                <path
                  fill="none"
                  stroke="url(#cheng-about-gradient)"
                  stroke-width="6.5"
                  d="M46.6 49.53A17 17 0 1 1 46.6 70.47"
                />
                <circle cx="60" cy="60" r="5.5" fill="url(#cheng-about-gradient)" />
              </g>
            </svg>
          </div>
          <h1 id="about-title" class="title">
            ${escapeHtml(input.applicationName)}<br />
            ${escapeHtml(input.versionLabel)} ${escapeHtml(input.appVersion)}
          </h1>
          <div class="meta">
            ${input.optimizationLine ? `<div>${escapeHtml(input.optimizationLine)}</div>` : ""}
            <div>${escapeHtml(input.copyright)}</div>
          </div>
        </div>
        <div class="spacer"></div>
        <button class="ok-button" type="button" autofocus>${escapeHtml(input.okButtonLabel)}</button>
      </section>
    </main>
    <script>
      const closeWindow = () => window.close();
      document.querySelector(".ok-button")?.addEventListener("click", closeWindow);
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" || event.key === "Enter") {
          closeWindow();
        }
      });
    </script>
  </body>
</html>`;
}
