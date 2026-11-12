import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  inputHash,
  refToString,
  type AskSpec,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";

/**
 * 词法出生阶段（docs/execution-engine.md「Identity: sites, ordinals, phases」）：`EngineConfig.sitePhases`
 * 在表里的站点按表打戳；**没有表**时（snippet / 老编译产物）才退回动态当前阶段。表在场而站点不在
 * 表里是编译期的一次表态——这个站点被几个阶段各执行一次（并行的几条 lane 共用一个评审 helper
 * 就是它）——ask 节点因此缺省，绝不拿最后一个跑过的标记（那是别的车道的）冒充。
 */

const RUN = "run";
const untyped = (...ids: string[]): Map<string, AskSpec> =>
  new Map(ids.map((id) => [id, { typed: false } as AskSpec]));

function setup(
  opts: { sitePhases?: ReadonlyMap<string, string>; journal?: InMemoryJournalStore } = {},
) {
  const journal = opts.journal ?? new InMemoryJournalStore();
  const driver = new FakeDriver(journal, {});
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: { maxConcurrency: 16 },
    askSpecs: untyped("ask#1", "ask#2", "ask#3"),
    validate: () => [],
    ...(opts.sitePhases === undefined ? {} : { sitePhases: opts.sitePhases }),
  });
  return { journal, driver, engine };
}

describe("WorkflowEngine — lexical birth phase (sitePhases)", () => {
  it("stamps a listed site with its lexical phase, whatever marker ran last", async () => {
    const { engine, driver } = setup({
      sitePhases: new Map([
        ["actor#1", "gather"],
        ["ask#1", "gather"],
        ["actor#2", "verify"],
        ["ask#2", "verify"],
      ]),
    });
    // 时序：两个 stage 的标记都已经过，当前阶段停在 verify；此时 gather 那一段在 await 之后
    // 才发出它的 ask——动态戳会说 verify，词法戳说 gather。
    engine.enterPhase("gather");
    engine.enterPhase("verify");
    const verifier = engine.createActor("actor#2", "verifier");
    void engine.ask("ask#2", verifier, "verify");
    const researcher = engine.createActor("actor#1", "researcher");
    void engine.ask("ask#1", researcher, "research");
    void engine.worldRead("world-read#1", "glob", ["src/**"]);
    await flush();

    expect(
      driver.eventsOfType("actor-created").map((e) => [refToString(e.actor), e.phaseName]),
    ).toEqual([
      ["actor#2@1", "verify"],
      ["actor#1@1", "gather"],
    ]);
    const queued = new Map(
      driver.eventsOfType("node-queued").map((e) => [refToString(e.instance), e.phaseName]),
    );
    expect(queued.get("ask#2@1")).toBe("verify");
    expect(queued.get("ask#1@1")).toBe("gather");
    // 不在表里的 world 节点仍取动态当前阶段（它没有「跨阶段」这层表意，见 engine-phase-stamp.ts）。
    expect(queued.get("world-read#1@1")).toBe("verify");
  });

  it("leaves an ask site the compile table declined unstamped instead of stamping the last marker", async () => {
    const { engine, driver } = setup({
      sitePhases: new Map([
        ["actor#1", "lane-a"],
        ["ask#1", "lane-a"],
        ["actor#2", "lane-b"],
        ["ask#2", "lane-b"],
        ["actor#3", "lane-b"],
      ]),
    });
    // 真跑的形状：两条 lane 的标记在各自 future 的开头同步跑完（最后一个是 lane-b），共用的评审
    // helper 在 await 之后才发出 ask#3。ask#3 被两个阶段各认领一次，于是不在编译期表里。
    engine.enterPhase("lane-a");
    engine.enterPhase("lane-b");
    const laneA = engine.createActor("actor#1", "lane-a");
    const laneB = engine.createActor("actor#2", "lane-b");
    const reviewer = engine.createActor("actor#3", "reviewer");
    void engine.ask("ask#1", laneA, "a");
    void engine.ask("ask#2", laneB, "b");
    void engine.ask("ask#3", reviewer, "shared review");
    await flush();

    const queued = (id: string) =>
      driver.eventsOfType("node-queued").find((e) => refToString(e.instance) === id);
    expect(queued("ask#1@1")?.phaseName).toBe("lane-a");
    expect(queued("ask#2@1")?.phaseName).toBe("lane-b");
    // 修复前这里是 lane-b：两个评审节点被绑到别的车道。表拒绝表态，就没有坐标——缺席，不伪造。
    expect(queued("ask#3@1")).toBeDefined();
    expect(queued("ask#3@1")).not.toHaveProperty("phaseName");
    // 派发重复出生事实，同样不戳。
    const dispatched = driver
      .eventsOfType("node-dispatched")
      .find((e) => refToString(e.instance) === "ask#3@1");
    expect(dispatched).toBeDefined();
    expect(dispatched).not.toHaveProperty("phaseName");
  });

  it("falls back to the dynamic phase for asks when no table is given at all", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("only");
    const actor = engine.createActor("actor#1", "a");
    void engine.ask("ask#1", actor, "x");
    await flush();
    expect(driver.eventsOfType("node-queued")[0]).toMatchObject({ phaseName: "only" });
  });

  it("leaves an unlisted instance unstamped before any marker", async () => {
    const { engine, driver } = setup({ sitePhases: new Map([["ask#2", "later"]]) });
    const actor = engine.createActor("actor#1", "a");
    void engine.ask("ask#1", actor, "x");
    await flush();
    expect(driver.eventsOfType("node-queued")[0]).not.toHaveProperty("phaseName");
  });

  it("keeps an old run's bare events bare and does not back-fill the replay's cached settle", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("shared review"),
      status: "completed",
      result: "r1",
    });
    // 旧 run 的出生事件：本规则之前记的，整个 phaseName 键缺席。
    journal.appendEvent(RUN, {
      type: "node-queued",
      instance: { siteId: "ask#1", ordinal: 1 },
      kind: "ask",
    });

    const { engine, driver } = setup({ journal, sitePhases: new Map([["actor#2", "P"]]) });
    engine.enterPhase("Q");
    const actor = engine.createActor("actor#1");
    await expect(engine.ask("ask#1", actor, "shared review")).resolves.toBe("r1");

    expect(driver.startAskCount()).toBe(0);
    // 重放的缓存结算就是这一世的出生事件：站点不在表里 ⇒ 不拿当前标记 Q 冒充。
    expect(driver.eventsOfType("node-settled")[0]).toMatchObject({ cached: true });
    expect(driver.eventsOfType("node-settled")[0]).not.toHaveProperty("phaseName");
    // journal 只追加：旧事件原样留着，不回头补戳。
    const old = journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .find((stored) => stored.event.type === "node-queued");
    expect(old?.event).not.toHaveProperty("phaseName");
  });
});
