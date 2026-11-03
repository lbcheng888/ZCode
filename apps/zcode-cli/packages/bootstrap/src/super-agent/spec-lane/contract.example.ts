/**
 * super-agent-spec-lane 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * dispatcher 组合根（mandate lane 裁定 speculative 档后）：起代理 → 无凭据 env →
 * 受限 profile → 建 run → 终态清代理。任一步失败即 run 拒绝启动（fail-closed）。
 */
import type { SuperAgentSpecLaneContract } from "./contract.js";
import { createSuperAgentSpecLane } from "./spec-lane.js";

export async function exampleSuperAgentSpecLane(): Promise<void> {
  const lane: SuperAgentSpecLaneContract = createSuperAgentSpecLane();

  // 1) 起 per-workspace egress 代理；per-repo 依赖镜像白名单显式传入（缺省 = 零 egress）。
  //    listen 失败抛 SpecEgressStartupError —— dispatcher 据此拒绝 run，不回退直连。
  const plan = await lane.prepareSpecRunEgress({
    workspaceRoot: "/repos/example",
    allowHosts: ["registry.npmjs.org", "pypi.org"],
  });

  // 2) 之后由组合根接执行适配器（示意，非本模块 API）：
  //    - createNodeExecutionAdapter({
  //        network: plan.networkPolicy,                        // 与 env 同源的代理策略
  //        processEnv: buildSpecRunEnv({ proxyUrl: plan.proxyUrl, sourceEnv: process.env }),
  //      })
  //    - Phase 3 spec run 只走 subagent 路径：用 core buildSpecRestrictedProfile()
  //      建受限 profile 建 subagent run（2026-11-02 裁定 A）。
  //      workflow 形态在 profile 接线前禁止启动 spec run——dispatcher 不得以 workflow
  //      形态建 spec run。接线接缝：后续给 workflow-facade / script-workflow-child-runtime
  //      增加 profile / processEnv 入参，接通后再评估 workflow 形态（spec §6-1）。

  // 3) run 终态（成功、失败、取消同路）：停代理。幂等。
  await lane.stopSpecRunEgress(plan.workspaceRoot);
}
