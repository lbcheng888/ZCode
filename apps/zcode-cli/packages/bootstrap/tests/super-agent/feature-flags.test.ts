import { describe, expect, it } from "vitest";

import { ConfigKey, DefaultRuntimeConfig } from "../../../contracts/src/config/index.js";
import { DEFAULT_BOT_COMMANDS, type BotConfig } from "../../../../../../packages/shared/src/bots.js";

// spec §5.4：features.* 四开关缺省全 false（legacy 直路 = kill-switch），BotConfig
// eventRouterEnabled 缺省 undefined（bot 维度灰度未开）。central typecheck 兜 BotConfig 类型面。
describe("super-agent Phase 2 feature flags 缺省关", () => {
  it("DefaultRuntimeConfig.features 控制面开关全 false（含 P6 围栏）", () => {
    expect(DefaultRuntimeConfig.features.eventRouter).toBe(false);
    expect(DefaultRuntimeConfig.features.mandateGate).toBe(false);
    expect(DefaultRuntimeConfig.features.specWriteLease).toBe(false);
    expect(DefaultRuntimeConfig.features.durableSchedulerDispatch).toBe(false);
    // P6 围栏缺省关 = 现状协作式 env 代理（字节行为不变）。
    expect(DefaultRuntimeConfig.features.specEgressFence).toBe(false);
    // 既有开关不受影响（goalLayer 缺省开是 Phase 1 转正结论）。
    expect(DefaultRuntimeConfig.features.goalLayer).toBe(true);
  });

  it("ConfigKey 拼写与 spec §5.4 一致（命名即接线）", () => {
    expect(ConfigKey.FeatureEventRouter).toBe("features.eventRouter");
    expect(ConfigKey.FeatureMandateGate).toBe("features.mandateGate");
    expect(ConfigKey.FeatureSpecWriteLease).toBe("features.specWriteLease");
    expect(ConfigKey.FeatureDurableSchedulerDispatch).toBe("features.durableSchedulerDispatch");
    expect(ConfigKey.FeatureSpecEgressFence).toBe("features.specEgressFence");
  });

  it("BotConfig.eventRouterEnabled 可选：未配置即 undefined（legacy 直路）", () => {
    const bot = {
      id: "bot-1",
      name: "Bot",
      provider: "feishu",
      enabled: true,
      allowedWorkspaces: [],
      allowedCommands: DEFAULT_BOT_COMMANDS,
      currentOptions: {},
      replyMode: "summary_changes",
    } satisfies BotConfig;
    expect(bot.eventRouterEnabled).toBeUndefined();
  });
});
