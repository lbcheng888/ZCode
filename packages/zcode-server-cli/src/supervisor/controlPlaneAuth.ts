/**
 * Supervisor 铸造的 control-plane 数据面认证凭据（milestone-b-spec §3.8）。
 *
 * Node 公共 API 不暴露内核 peer credential；生产认证改为显式凭据握手：Supervisor 在
 * daemon 启动期生成随机凭据并原子写入 0600 文件，Core 连接首帧提交、child 校验。
 * 同 UID 可读 0600 文件的攻击面仍是设计 §5 登记的范围（不承诺），凭据替代的是
 * 「恒拒绝」的 peer resolver，不是内核级 peer 身份。
 *
 * 每次 daemon 启动重新铸造：Core 在 child 之后重启时读同一文件，租约/连接不中断。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveControlPlaneAuthTokenPath } from "@zcode/shared/super-agent-control-plane-protocol";

export async function ensureControlPlaneAuthToken(serverRoot: string): Promise<string> {
  const tokenPath = resolveControlPlaneAuthTokenPath(serverRoot);
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const temporary = `${tokenPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, token, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, tokenPath);
    if (process.platform !== "win32") await chmod(tokenPath, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return token;
}

export async function removeControlPlaneAuthToken(serverRoot: string): Promise<void> {
  await rm(resolveControlPlaneAuthTokenPath(serverRoot), { force: true });
}
