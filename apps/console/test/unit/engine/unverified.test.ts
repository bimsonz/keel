import { describe, expect, it } from "vitest";
import { createRng } from "../../fixtures/prng.ts";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { lanesOf } from "../../../src/engine/lanes.ts";
import { changePageOf, trunkStatsOf } from "../../../src/engine/select.ts";
import { World } from "../../../src/engine/world.ts";

const NO_RESOURCES = {
  probes: new Map(),
  diffs: new Map(),
  verdicts: new Map(),
  lattices: new Map(),
  refused: new Set<string>(),
};

/** One change through a project whose verification is switched off, or on. `landed`: whether its advance has happened yet. */
function worldWith(verified: boolean | undefined, landed = true, verdictSaysSo = true): World {
  const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(3));
  const flag = verified === undefined ? {} : { verified };
  b.at(1).emit({
    type: "AgentEnrolled",
    entity: { kind: "agent", id: "agt_1" },
    payload: {
      agentId: "agt_1",
      projectId: "prj_1",
      name: "agent",
      kind: "hosted",
      scopes: ["agent:work"],
    },
  });
  b.emit({
    type: "SubjectMinted",
    entity: { kind: "subject", id: "sub_1" },
    payload: { subjectId: "sub_1", key: "s.x", anchors: [], gloss: "", mintedBy: "scan" },
  });
  b.emit({
    type: "IntentDeclared",
    entity: { kind: "change", id: "chg_1" },
    payload: {
      changeId: "chg_1",
      agentId: "agt_1",
      origin: "agent",
      revision: 1,
      goal: "g",
      footprint: [],
      premises: [{ subject: "s.x", predicate: "bound", relation: "at-most", value: "tight" }],
      leaseId: "l",
    },
  });
  b.at(2).emit({
    type: "VerdictIssued",
    entity: { kind: "verdict", id: "vrd_1" },
    payload: {
      verdictId: "vrd_1",
      subject: "chg_1",
      outcome: "land",
      evidence: [],
      ...(verdictSaysSo ? flag : {}),
    },
  });
  b.at(3).emit({
    type: "TrunkAdvanced",
    entity: { kind: "trunk", id: "prj_1" },
    payload: {
      projectId: "prj_1",
      from: "a",
      to: "b",
      groupId: "g",
      landings: [{ changeId: "chg_1", commitSha: "c1", candidateId: "cnd_1", proofId: "prf_1" }],
      height: 7,
      ...flag,
    },
  });
  const world = new World();
  const log = b.build();
  log.events.forEach((event, index) => {
    if (landed || event.type !== "TrunkAdvanced") world.apply(event, log.eventTimes[index] ?? 0);
  });
  return world;
}

describe("a project with verification switched off", () => {
  it("is marked wherever its changes and advances are shown", () => {
    const world = worldWith(false);
    expect(trunkStatsOf(world, 3_000)).toMatchObject({ advances: 7, unverifiedAdvances: 1 });
    expect(changePageOf(world, "chg_1", NO_RESOURCES)?.change.unverified).toBe(true);
    expect(
      lanesOf(world, 2_500)
        .lanes.flatMap((lane) => lane.nodes)
        .find((node) => node.kind === "change"),
    ).toMatchObject({ unverified: true });
  });

  it("marks a change from its advance alone, where its verdict did not say", () => {
    const world = worldWith(false, true, false);
    expect(changePageOf(world, "chg_1", NO_RESOURCES)?.change.unverified).toBe(true);
  });

  it("marks a change from its verdict alone, before it has landed", () => {
    const world = worldWith(false, false);
    expect(trunkStatsOf(world, 3_000)).toMatchObject({ unverifiedAdvances: 0 });
    expect(changePageOf(world, "chg_1", NO_RESOURCES)?.change.unverified).toBe(true);
  });

  it("is the only thing marked: a project that verifies, or does not say, carries no mark", () => {
    for (const verified of [true, undefined]) {
      const world = worldWith(verified);
      expect(trunkStatsOf(world, 3_000)).toMatchObject({ advances: 7, unverifiedAdvances: 0 });
      expect(changePageOf(world, "chg_1", NO_RESOURCES)?.change.unverified).toBe(false);
      expect(
        lanesOf(world, 2_500)
          .lanes.flatMap((lane) => lane.nodes)
          .find((node) => node.kind === "change"),
      ).not.toHaveProperty("unverified");
    }
  });
});

describe("the advance count", () => {
  it("is Keel's own, and an advance that does not say its height is never counted here", () => {
    const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(3));
    const advance = (to: string, height?: number): void => {
      b.after(1).emit({
        type: "TrunkAdvanced",
        entity: { kind: "trunk", id: "prj_1" },
        payload: {
          projectId: "prj_1",
          from: "a",
          to,
          groupId: `g-${to}`,
          landings: [],
          ...(height === undefined ? {} : { height }),
        },
      });
    };
    advance("b", 41);
    advance("c");
    const world = new World();
    const log = b.build();
    log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
    // The head moves with every advance. The count stays where Keel last put it.
    expect(world.trunk).toMatchObject({ head: "c", advances: 41 });
  });
});
