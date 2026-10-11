import { describe, expect, it } from "vitest";
import type { Player } from "../../../../src/engine/player.ts";
import { changePageOf } from "../../../../src/engine/select.ts";
import { World } from "../../../../src/engine/world.ts";
import { createMockSource } from "../../../fixtures/mock/MockSource.ts";
import { checkLog, finalStates } from "../../../fixtures/mock/conformance.ts";
import { generateS2 } from "../../../fixtures/mock/s2.ts";
import { showing } from "../../showing.ts";

async function playerAt(seconds: number): Promise<Player> {
  const player = showing(createMockSource({ scenario: "s2", seed: 42 }));
  await player.load();
  player.seek(seconds * 1000);
  return player;
}

describe("scenario 2: memory", () => {
  it("conforms to the catalogue and the state machines, history included", () => {
    expect(checkLog(generateS2(42).events)).toEqual([]);
    expect(JSON.stringify(generateS2(42).events)).toBe(JSON.stringify(generateS2(42).events));
  });

  it("opens on the world scenario 1 left behind, 1,143 advances later", async () => {
    const player = await playerAt(0);
    expect(player.world.trunk).toMatchObject({ advances: 1143, changesLanded: 2, redCount: 0 });
    expect(
      [...player.world.decisions.values()].map((decision) => [decision.label, decision.state]),
    ).toEqual([["D-1", "active"]]);
    expect([...player.world.guards.values()].map((guard) => [guard.label, guard.state])).toEqual([
      ["G-1", "admitted"],
    ]);
    // The story proper has not started.
    expect([...player.world.changes.values()].map((change) => change.label).toSorted()).toEqual([
      "#1",
      "#2",
    ]);
  });

  it("surfaces the decision to the fresh agent as dated evidence, and records that it followed it", async () => {
    const player = await playerAt(125);
    const c = [...player.world.changes.values()].find((change) => change.label === "#1204");
    const file = changePageOf(player.world, c?.id ?? "", player);
    expect(file?.change.state).toBe("landed");
    expect(file?.precedents).toEqual([
      {
        decisionLabel: "D-1",
        summary: "Cache allowed if revocation invalidates it",
        decidedAt: "2026-10-13T10:21:52.400Z",
        scope: "authz.permission-evaluation",
        stance: "followed",
      },
    ]);
    expect(file?.plan.steps.find((step) => step.id === "guard")).toMatchObject({
      outcome: "pass",
      because: "Decision D-1: cache allowed if revocation invalidates it",
    });
    expect(player.world.trunk.advances).toBe(1144);
  });

  it("bounces the careless change on the guard, citing the decision, and trunk stays green", async () => {
    const player = await playerAt(200);
    const h = [...player.world.changes.values()].find((change) => change.label === "#1205");
    // The verdict's event carries references. Its evidence is read from Keel's view of the verdict, when the change's page is opened.
    expect(changePageOf(player.world, h?.id ?? "", player)?.verdict?.evidence).toEqual([]);
    player.wantVerdict(h?.id ?? "");
    await Promise.resolve();
    await Promise.resolve();
    const file = changePageOf(player.world, h?.id ?? "", player);
    expect(file?.change.state).toBe("bounced");
    expect(file?.verdict).toMatchObject({
      outcome: "bounce",
      summary: "Guard G-1 fails: the change strips the invalidation that Decision D-1 requires",
    });
    expect(file?.verdict?.evidence.map((item) => item.class)).toEqual([
      "proof",
      "ruling",
      "ruling",
    ]);
    expect(file?.plan.steps.find((step) => step.id === "guard")?.outcome).toBe("fail");
    expect(file?.precedents[0]).toMatchObject({ decisionLabel: "D-1" });
    expect(file?.precedents[0]?.stance).toBeUndefined();
    expect(player.world.trunk).toMatchObject({ advances: 1144, redCount: 0 });
    const states = finalStates(generateS2(42).events);
    expect(
      [...states].filter(([key]) => key.startsWith("tenet:")).map(([, state]) => state),
    ).toEqual(["established"]);
  });

  it("records the guard's failure as a fact of the change, before any batch exists, and proves the conflict by it", () => {
    const events = generateS2(42).events;
    const failed = events.find((event) => event.type === "GuardFailed");
    expect(failed?.entity).toEqual({ kind: "change", id: failed?.payload.changeId });
    expect(failed?.payload).not.toHaveProperty("batchId");
    expect(failed?.payload).not.toHaveProperty("candidateId");
    const proven = events.findLast((event) => event.type === "ConflictProven");
    expect(proven?.payload.evidence).toEqual({ _tag: "guard", guardId: failed?.payload.guardId });
    expect(events.findIndex((event) => event.type === "GuardFailed")).toBeLessThan(
      events.findLastIndex((event) => event.type === "ConflictProven"),
    );
  });

  it("takes a plan that is only a count of steps, as Keel's code commits one today, and lists none", async () => {
    const bare = new World();
    const { items } = await createMockSource({ scenario: "s2", seed: 42 }).readEvents({
      limit: 500,
    });
    for (const event of items) {
      // What Keel's core commits today: how many steps the plan has, and not the steps.
      bare.apply(
        event.type === "PlanCompiled"
          ? { ...event, payload: { ...event.payload, steps: 9 } }
          : event,
        0,
      );
    }
    const h = [...bare.changes.values()].find((change) => change.label === "#1205");
    const plan = changePageOf(bare, h?.id ?? "", {
      diffs: new Map(),
      probes: new Map(),
      verdicts: new Map(),
      lattices: new Map(),
      refused: new Set<string>(),
    })?.plan;
    expect(plan).toMatchObject({ hash: "plan:1b7e…90ad", steps: [], stepCount: 9 });
    expect(plan).not.toHaveProperty("spec");
  });

  it("reads the plan's guard step as failed from Keel's fact alone, with no step observation to go on", async () => {
    // As a live Keel publishes it today: events, and nothing of the console's own beside them.
    const bare = new World();
    const { items } = await createMockSource({ scenario: "s2", seed: 42 }).readEvents({
      limit: 500,
    });
    for (const event of items) bare.apply(event, 0);
    const h = [...bare.changes.values()].find((change) => change.label === "#1205");
    const steps =
      changePageOf(bare, h?.id ?? "", {
        diffs: new Map(),
        probes: new Map(),
        verdicts: new Map(),
        lattices: new Map(),
        refused: new Set<string>(),
      })?.plan.steps ?? [];
    expect(bare.steps.size).toBe(0);
    expect(steps.find((step) => step.id === "guard")?.outcome).toBe("fail");
    expect(steps.find((step) => step.id === "unit")?.outcome).toBe("pending");
    // The change that kept the invalidation never failed it.
    const c = [...bare.changes.values()].find((change) => change.label === "#1204");
    expect(
      changePageOf(bare, c?.id ?? "", {
        diffs: new Map(),
        probes: new Map(),
        verdicts: new Map(),
        lattices: new Map(),
        refused: new Set<string>(),
      })?.plan.steps.find((step) => step.id === "guard")?.outcome,
    ).toBe("pending");
  });
});
