import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createConfig } from "@zcode/adapters/config";
import { buildSpecRunEnv } from "../../../adapters/src/network/subprocess-env.js";
import {
  createSpecRunDispatcher,
  createSuperAgentSpecLane,
  resolveSpecEgressAllowHosts,
  type SpecRunLaunchRequest,
} from "../../src/super-agent/spec-lane/index.js";

const roots: string[] = [];
const servers: Server[] = [];

afterAll(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startMirror(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("mirror-ok");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return { server, port: address.port };
}

async function requestViaProxy(
  proxyUrl: string,
  targetUrl: string,
): Promise<{ statusCode: number; body: string }> {
  const proxy = new URL(proxyUrl);
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: proxy.hostname,
        port: proxy.port,
        path: targetUrl,
        method: "GET",
        headers: { Host: new URL(targetUrl).host },
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

describe("specEgress.allowHosts repo config → resolveAllowHosts → real proxy", () => {
  it("reads the project config and allows only the configured host through the real spec proxy", async () => {
    const root = await mkdtemp(join(tmpdir(), "spec-egress-config-"));
    roots.push(root);
    await mkdir(join(root, ".zcode"), { recursive: true });
    const mirror = await startMirror();
    const allowHosts = [`127.0.0.1:${mirror.port}`];
    await writeFile(
      join(root, ".zcode", "config.json"),
      JSON.stringify({ specEgress: { allowHosts } }),
    );

    // 真实 repo 配置读取（project config schema 必须显式开放 specEgress）。
    const configResult = createConfig({
      workingDirectory: root,
      skipUserConfig: true,
      env: {},
    });
    expect(configResult.sources.project.paths).toContain(join(root, ".zcode", "config.json"));
    expect(configResult.config.specEgress.allowHosts).toEqual(allowHosts);
    const resolved = resolveSpecEgressAllowHosts(configResult.config.specEgress.allowHosts);

    const observed: Array<{ statusCode: number; body: string }> = [];
    const launch = async (request: SpecRunLaunchRequest): Promise<{ runId: string }> => {
      const proxyUrl = request.processEnv.HTTP_PROXY;
      expect(proxyUrl).toBeDefined();
      observed.push(
        await requestViaProxy(proxyUrl!, `http://127.0.0.1:${mirror.port}/`),
        await requestViaProxy(proxyUrl!, `http://localhost:${mirror.port}/`),
      );
      return { runId: "run-egress-e2e" };
    };
    const dispatcher = createSpecRunDispatcher({
      egress: createSuperAgentSpecLane(),
      buildProcessEnv: (plan) =>
        buildSpecRunEnv({ proxyUrl: plan.proxyUrl, sourceEnv: {} }),
      launch: { launch },
      resolveWorkspaceRoot: () => root,
      resolveAllowHosts: () => resolved,
    });

    await dispatcher.start({
      triggerId: "trig-egress-e2e",
      workspaceIdentity: "ws-egress-e2e",
      threadKey: "thread-egress-e2e",
      source: "im",
      tier: "speculative",
    });

    expect(observed).toEqual([
      { statusCode: 200, body: "mirror-ok" },
      {
        statusCode: 403,
        body: `spec-egress: host 不在 allowlist: localhost:${mirror.port}`,
      },
    ]);
  });

  it("validates allowlist shape at the startup seam", () => {
    expect(resolveSpecEgressAllowHosts([])).toEqual([]);
    expect(resolveSpecEgressAllowHosts([" registry.npmjs.org "])).toEqual([
      "registry.npmjs.org",
    ]);
    // 裸 IPv6 是不可匹配的死条目：启动期必须响亮拒绝，不静默丢弃。
    expect(() => resolveSpecEgressAllowHosts(["fe80::1"])).toThrow(/裸 IPv6/);
    expect(() => resolveSpecEgressAllowHosts(["host:99999"])).toThrow(/端口越界/);
  });
});
