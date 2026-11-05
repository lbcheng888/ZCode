/**
 * §3.8 peer 身份：原生 addon 优先，缺失即 unavailable（Linux 才退 `/proc` 启发式）。
 *
 * 真实断言用真实 Unix socket + 真实子进程：server 侧从 accepted socket 的内核凭据
 * 读出 peer PID，必须等于 client 子进程的 `child.pid`。macOS 与 Linux 路径分别按平台
 * 守卫；Windows 源码存在但本机无法验证，不在此伪造通过。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createPlatformPeerIdentityResolver,
  loadNativePeerCredentials,
  type NativePeerCredentials,
} from "../../src/super-agent/daemon/peerIdentity.js";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const addonPath = join(
  repoRoot,
  "packages",
  "native-peer-credentials",
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "peercred.node",
);
const buildScript = join(repoRoot, "scripts", "build-native-peer-credentials.mjs");

// 产物被 .gitignore（不在干净 checkout 里）：用例自己显式构建，工具链缺失就失败，
// 不用「产物碰巧存在」来决定是否 skip。
beforeAll(() => {
  // Windows 运行时不可用（见 peerIdentity.ts），不在测试里强制 MSVC 构建。
  if (process.platform === "win32") return;
  if (existsSync(addonPath)) return;
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to build native peer credentials addon: ${result.stderr || result.stdout || result.error}`,
    );
  }
  if (!existsSync(addonPath)) {
    throw new Error(`build script finished without producing ${addonPath}`);
  }
});

const children = new Set<ReturnType<typeof spawn>>();
const servers = new Set<ReturnType<typeof createServer>>();
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const server of servers) server.close();
  servers.clear();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const CLIENT_SCRIPT = `
const net = require("node:net");
const socket = net.connect(process.argv[1]);
socket.on("error", () => process.exit(2));
setInterval(() => {}, 1000);
`;

/** 真实 Unix socket：父进程 server 接受子进程连接，返回解析出的身份。 */
async function resolveRealPeer(
  native: NativePeerCredentials,
): Promise<{ identity: Awaited<ReturnType<ReturnType<typeof createPlatformPeerIdentityResolver>["resolve"]>>; childPid: number }> {
  const root = await mkdtemp(join(tmpdir(), "zcode-peer-identity-"));
  temporaryRoots.push(root);
  const socketPath = join(root, "peer.sock");
  const server = createServer();
  servers.add(server);
  const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  const child = spawn(process.execPath, ["-e", CLIENT_SCRIPT, socketPath], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.add(child);
  if (child.pid === undefined) throw new Error("client child did not expose a pid");
  const socket = await accepted;
  const resolver = createPlatformPeerIdentityResolver(process.platform, { native });
  const identity = await resolver.resolve(socket);
  socket.destroy();
  server.close();
  servers.delete(server);
  return { identity, childPid: child.pid };
}

describe("native peer credentials loading", () => {
  it("returns undefined when the addon file is absent (never a fake identity)", () => {
    expect(
      loadNativePeerCredentials({ addonPath: join(tmpdir(), "missing-peercred.node") }),
    ).toBeUndefined();
  });

  it.skipIf(process.platform === "linux")(
    "reports unavailable on macOS/Windows when no native addon is loadable",
    async () => {
      const resolver = createPlatformPeerIdentityResolver(process.platform, {});
      const identity = await resolver.resolve({} as Socket);
      expect(identity.kind).toBe("unavailable");
      expect(identity.kind === "unavailable" ? identity.reason : "").toContain(
        "native peer credentials addon unavailable",
      );
    },
  );
});

describe("native peer identity against a real socket", () => {
  it.skipIf(process.platform !== "darwin")(
    "LOCAL_PEERPID resolves the real client pid on macOS",
    async () => {
      const native = loadNativePeerCredentials({ addonPath });
      expect(native).toBeDefined();
      const { identity, childPid } = await resolveRealPeer(native!);
      expect(identity).toMatchObject({ kind: "resolved", pid: childPid });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "SO_PEERCRED resolves the real client pid on Linux",
    async () => {
      const native = loadNativePeerCredentials({ addonPath });
      expect(native).toBeDefined();
      const { identity, childPid } = await resolveRealPeer(native!);
      expect(identity).toMatchObject({ kind: "resolved", pid: childPid });
      if (identity.kind === "resolved") {
        expect(identity.uid).toBe(process.getuid?.());
        expect(identity.gid).toBe(process.getgid?.());
      }
    },
  );
});
