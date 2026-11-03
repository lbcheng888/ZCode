// super-agent-spec-lane（M5 受限 profile + egress 代理强制）实施测试。
// 锚：docs/architecture/super-agent-spec-lane-spec.md §5 测试表——代理 allow/deny 矩阵、
// CONNECT 门禁、真实 curl 对抗（白名单 mirror 通过、非白名单 host 必失败）、
// fail-closed 启动、per-workspace 注册表语义、env 凭据真空与 toolface 零出站合流。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { describe, expect, it } from "vitest";

import { buildSpecRunEnv } from "../../adapters/src/network/subprocess-env.js";
import {
  buildSpecRestrictedProfile,
  filterSpecRestrictedToolNames,
} from "../../core/src/subagent/tool-policy.js";
import {
  SpecEgressStartupError,
  createSuperAgentSpecLane,
  normalizeSpecEgressAllowlist,
} from "../src/super-agent/spec-lane/index.js";

async function listen(server: Server | TcpServer, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("无法解析监听端口");
  return address.port;
}

async function close(server: Server | TcpServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** 本地「依赖镜像」HTTP 服务器：对任意请求回 200 mirror-ok。 */
async function startMirror(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("mirror-ok");
  });
  const port = await listen(server);
  return { server, port };
}

/** 经代理发请求（absolute-form 传绝对 URI；origin-form 传路径，用于断言代理拒收）。 */
async function requestViaProxy(
  proxyUrl: string,
  targetUrl: string,
): Promise<{ statusCode: number; body: string }> {
  const proxy = new URL(proxyUrl);
  const hostHeader = targetUrl.startsWith("http://") ? new URL(targetUrl).host : "origin-form.test";
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: proxy.hostname,
        port: proxy.port,
        path: targetUrl,
        method: "GET",
        headers: { Host: hostHeader },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 经代理发 CONNECT；返回代理的第一行响应。 */
async function connectViaProxy(
  proxyUrl: string,
  connectTarget: string,
): Promise<string> {
  const proxy = new URL(proxyUrl);
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxy.port), proxy.hostname, () => {
      socket.write(`CONNECT ${connectTarget} HTTP/1.1\r\nHost: ${connectTarget}\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(text.split("\r\n")[0] ?? "");
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text.split("\r\n")[0] ?? "");
    });
  });
}

describe("super-agent-spec-lane (M5 egress enforcement)", () => {
  it("passes allowlisted hosts and rejects everything else (HTTP matrix)", async () => {
    const lane = createSuperAgentSpecLane();
    const mirror = await startMirror();
    try {
      const plan = await lane.prepareSpecRunEgress({
        workspaceRoot: "/repos/matrix",
        allowHosts: ["127.0.0.1"],
      });

      // 白名单 host：直通并拿到镜像响应。
      const allowed = await requestViaProxy(plan.proxyUrl, `http://127.0.0.1:${mirror.port}/`);
      expect(allowed.statusCode).toBe(200);
      expect(allowed.body).toBe("mirror-ok");

      // 非白名单 host 字面量（localhost ≠ 127.0.0.1）：403。
      const denied = await requestViaProxy(plan.proxyUrl, `http://localhost:${mirror.port}/`);
      expect(denied.statusCode).toBe(403);

      // origin-form（把代理当普通服务器打）：400，不转发。
      const originForm = await requestViaProxy(plan.proxyUrl, `/not-absolute`);
      expect(originForm.statusCode).toBe(400);

      await lane.stopSpecRunEgress("/repos/matrix");
    } finally {
      await close(mirror.server);
    }
  });

  it("honors host:port entries and rejects port mismatches", async () => {
    const lane = createSuperAgentSpecLane();
    const mirror = await startMirror();
    const other = await startMirror();
    try {
      const plan = await lane.prepareSpecRunEgress({
        workspaceRoot: "/repos/hostport",
        allowHosts: [`127.0.0.1:${mirror.port}`],
      });

      const allowed = await requestViaProxy(plan.proxyUrl, `http://127.0.0.1:${mirror.port}/`);
      expect(allowed.statusCode).toBe(200);

      // host 命中但 port 不符：403。
      const portMismatch = await requestViaProxy(
        plan.proxyUrl,
        `http://127.0.0.1:${other.port}/`,
      );
      expect(portMismatch.statusCode).toBe(403);

      await lane.stopSpecRunEgress("/repos/hostport");
    } finally {
      await close(mirror.server);
      await close(other.server);
    }
  });

  it("defaults to zero egress when no allowlist is given", async () => {
    const lane = createSuperAgentSpecLane();
    const mirror = await startMirror();
    try {
      const plan = await lane.prepareSpecRunEgress({ workspaceRoot: "/repos/zero" });
      expect(plan.allowHosts).toEqual([]);
      const denied = await requestViaProxy(plan.proxyUrl, `http://127.0.0.1:${mirror.port}/`);
      expect(denied.statusCode).toBe(403);
      await lane.stopSpecRunEgress("/repos/zero");
    } finally {
      await close(mirror.server);
    }
  });

  it("gates CONNECT tunnels by allowlist", async () => {
    const lane = createSuperAgentSpecLane();
    const mirror = await startMirror();
    try {
      const plan = await lane.prepareSpecRunEgress({
        workspaceRoot: "/repos/connect",
        allowHosts: ["127.0.0.1"],
      });

      const allowed = await connectViaProxy(plan.proxyUrl, `127.0.0.1:${mirror.port}`);
      expect(allowed).toBe("HTTP/1.1 200 Connection Established");

      const denied = await connectViaProxy(plan.proxyUrl, `localhost:${mirror.port}`);
      expect(denied).toBe("HTTP/1.1 403 Forbidden");

      await lane.stopSpecRunEgress("/repos/connect");
    } finally {
      await close(mirror.server);
    }
  });

  it("adversarial curl: allowlisted mirror passes, non-allowlisted host fails inside a spec run env", async () => {
    const lane = createSuperAgentSpecLane();
    const mirror = await startMirror();
    try {
      const plan = await lane.prepareSpecRunEgress({
        workspaceRoot: "/repos/curl",
        allowHosts: ["127.0.0.1"],
      });
      // spec run 子进程 env：白名单拷贝 + 代理注入；随请求带假凭据断言真空（§5 env 行）。
      const env = buildSpecRunEnv({
        proxyUrl: plan.proxyUrl,
        sourceEnv: {
          ...process.env,
          GITHUB_TOKEN: "ghp_spec_secret_bytes",
          ANTHROPIC_API_KEY: "sk-spec-secret-bytes",
        },
      });
      expect(JSON.stringify(env)).not.toContain("spec_secret_bytes");

      // 白名单 mirror：curl 退出 0。（异步 spawn：execFileSync 会阻塞事件循环，
      // 同进程的代理将无法响应 curl——本测试与代理同进程。）
      const allowedOutput = await execFileAsync(
        "curl",
        ["-fsS", "--max-time", "15", `http://127.0.0.1:${mirror.port}/`],
        { env, encoding: "utf8" },
      );
      expect(allowedOutput.stdout).toBe("mirror-ok");

      // 非白名单 host（localhost 字面量）：curl -f 必须非零退出（代理 403）。
      await expect(
        execFileAsync("curl", ["-fsS", "--max-time", "15", `http://localhost:${mirror.port}/`], {
          env,
          encoding: "utf8",
        }),
      ).rejects.toMatchObject({ code: 22 });

      // toolface 合流断言：受限 profile 工具面零出站（§5 toolface 行）。
      const profile = buildSpecRestrictedProfile();
      const toolface = filterSpecRestrictedToolNames(profile.tools ?? []);
      expect([...toolface]).toEqual([...(profile.tools ?? [])]);
      expect(toolface).not.toContain("WebFetch");

      await lane.stopSpecRunEgress("/repos/curl");
    } finally {
      await close(mirror.server);
    }
  });

  // 钉住的已知残留（裁定 B，2026-11-02，spec §0/§5/§8-6）：env 级 egress 代理是协作式
  // 第二层——对不读代理 env 的客户端无效。以下两例**如实断言绕过成立**（非拦截），
  // 是设计边界的能力证据，不是缺陷回归；禁止把断言改成"绕过失败"。OS 级围栏
  // （网络命名空间/防火墙）是把残留升级为结构性拦截的后续路径（Phase 6 前置）。
  it("pins the known residual: curl --noproxy bypasses the env-level proxy to a non-allowlisted host", async () => {
    const lane = createSuperAgentSpecLane();
    const mirror = await startMirror();
    try {
      // allowlist 只有无关 host：走代理的客户端打 127.0.0.1 必 403（对照组）。
      const plan = await lane.prepareSpecRunEgress({
        workspaceRoot: "/repos/bypass-noproxy",
        allowHosts: ["registry.npmjs.org"],
      });
      const env = buildSpecRunEnv({
        proxyUrl: plan.proxyUrl,
        sourceEnv: { ...process.env },
      });

      // 对照：默认 curl（读代理 env）被代理 403 拒绝——协作层对守规矩客户端生效。
      await expect(
        execFileAsync("curl", ["-fsS", "--max-time", "15", `http://127.0.0.1:${mirror.port}/`], {
          env,
          encoding: "utf8",
        }),
      ).rejects.toMatchObject({ code: 22 });

      // 残留钉住：curl --noproxy '*' 显式绕过代理 env，直连非白名单 host 成功。
      const bypassed = await execFileAsync(
        "curl",
        ["-fsS", "--noproxy", "*", "--max-time", "15", `http://127.0.0.1:${mirror.port}/`],
        { env, encoding: "utf8" },
      );
      expect(bypassed.stdout).toBe("mirror-ok");

      await lane.stopSpecRunEgress("/repos/bypass-noproxy");
    } finally {
      await close(mirror.server);
    }
  });

  it("pins the known residual: node fetch (undici, ignores proxy env) reaches a non-allowlisted host", async () => {
    const lane = createSuperAgentSpecLane();
    const mirror = await startMirror();
    try {
      const plan = await lane.prepareSpecRunEgress({
        workspaceRoot: "/repos/bypass-undici",
        allowHosts: ["registry.npmjs.org"],
      });
      const env = buildSpecRunEnv({
        proxyUrl: plan.proxyUrl,
        sourceEnv: { ...process.env },
      });

      // 残留钉住：Node 内置 fetch 走 undici，默认不读 HTTP_PROXY/HTTPS_PROXY env，
      // 直连非白名单 host 成功——env 级代理对不读代理 env 的客户端无强制力。
      const script = `fetch(${JSON.stringify(`http://127.0.0.1:${mirror.port}/`)})
        .then((r) => r.text())
        .then((t) => { console.log(t); process.exit(0); })
        .catch((e) => { console.error(e); process.exit(1); });`;
      const fetchOut = await execFileAsync(process.execPath, ["-e", script], {
        env,
        encoding: "utf8",
      });
      expect(fetchOut.stdout.trim()).toBe("mirror-ok");

      await lane.stopSpecRunEgress("/repos/bypass-undici");
    } finally {
      await close(mirror.server);
    }
  });

  it("fails closed when the proxy port is occupied and leaves no partial state", async () => {
    const lane = createSuperAgentSpecLane();
    const blocker = createTcpServer();
    const port = await listen(blocker);
    try {
      await expect(
        lane.prepareSpecRunEgress({ workspaceRoot: "/repos/occupied", port }),
      ).rejects.toBeInstanceOf(SpecEgressStartupError);
      // 半开状态不存在：stop 幂等 no-op。
      await expect(lane.stopSpecRunEgress("/repos/occupied")).resolves.toBeUndefined();
    } finally {
      await close(blocker);
    }
  });

  it("replaces the previous proxy for the same workspace and stops idempotently", async () => {
    const lane = createSuperAgentSpecLane();
    const first = await lane.prepareSpecRunEgress({ workspaceRoot: "/repos/reuse" });
    const second = await lane.prepareSpecRunEgress({ workspaceRoot: "/repos/reuse" });
    try {
      expect(second.proxyUrl).not.toBe(first.proxyUrl);
      // 旧实例已停：对旧端口的代理请求必须失败。
      await expect(requestViaProxy(first.proxyUrl, "http://127.0.0.1:1/")).rejects.toThrow();
      // 新实例在跑：空 allowlist 下白名单外 host 是 403（服务器活着才可能 403）。
      const alive = await requestViaProxy(second.proxyUrl, "http://example.invalid/");
      expect(alive.statusCode).toBe(403);
    } finally {
      await lane.stopSpecRunEgress("/repos/reuse");
      await lane.stopSpecRunEgress("/repos/reuse");
    }
  });

  it("rejects malformed allowlist configs loudly", () => {
    expect(() => normalizeSpecEgressAllowlist(["registry.npmjs.org"])).not.toThrow();
    expect(() => normalizeSpecEgressAllowlist(["registry.npmjs.org:443"])).not.toThrow();
    expect(() => normalizeSpecEgressAllowlist([123])).toThrow(/必须是字符串/);
    expect(() => normalizeSpecEgressAllowlist([""])).toThrow(/空串/);
    expect(() => normalizeSpecEgressAllowlist(["host:"])).toThrow(/形状非法/);
    expect(() => normalizeSpecEgressAllowlist(["host:0"])).toThrow(/端口越界/);
    expect(() => normalizeSpecEgressAllowlist("oops")).toThrow(/字符串数组/);
  });

  it("accepts bracketed IPv6 entries and rejects bare IPv6 (no silent dead entries)", () => {
    // IPv6 只接受 [::1] / [::1]:port 形态；host 存无括号形式，与 CONNECT 解析对齐。
    expect(normalizeSpecEgressAllowlist(["[::1]"])).toEqual([{ host: "::1" }]);
    expect(normalizeSpecEgressAllowlist(["[::1]:443"])).toEqual([{ host: "::1", port: 443 }]);
    expect(normalizeSpecEgressAllowlist(["[FE80::1]"])).toEqual([{ host: "fe80::1" }]);

    // 裸 IPv6（多个冒号、无方括号）曾被 host:port 切分误解析成死条目
    // （"fe80::1" → {host:"fe80:", port:1}，永远匹配不上）——现在必须响亮抛错。
    expect(() => normalizeSpecEgressAllowlist(["fe80::1"])).toThrow(/形状非法/);
    expect(() => normalizeSpecEgressAllowlist(["::1"])).toThrow(/形状非法/);
    expect(() => normalizeSpecEgressAllowlist(["2001:db8::1"])).toThrow(/形状非法/);
    // 方括号形态的残缺写法同样抛。
    expect(() => normalizeSpecEgressAllowlist(["[::1"])).toThrow(/形状非法/);
    expect(() => normalizeSpecEgressAllowlist(["[]"])).toThrow(/形状非法/);
    expect(() => normalizeSpecEgressAllowlist(["[::1]:abc"])).toThrow(/形状非法/);
    expect(() => normalizeSpecEgressAllowlist(["[::1]:70000"])).toThrow(/端口越界/);
  });
});
