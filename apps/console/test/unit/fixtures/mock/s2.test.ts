import { describe, expect, it } from "vitest";
import type { AnyEvent } from "../../../../src/contract/events.ts";
import type { Player } from "../../../../src/engine/player.ts";
import { changePageOf } from "../../../../src/engine/select.ts";
import { World } from "../../../../src/engine/world.ts";
import { createMockSource } from "../../../fixtures/mock/MockSource.ts";
import { checkLog, finalStates } from "../../../fixtures/mock/conformance.ts";
import { S2_DECIDED, generateS2 } from "../../../fixtures/mock/s2.ts";
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
        decisionId: [...player.world.decisions.keys()][0],
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

  it("bounces the careless change on its batch's verdict, citing the decision, and trunk stays green", async () => {
    const player = await playerAt(200);
    const h = [...player.world.changes.values()].find((change) => change.label === "#1205");
    const [decision] = [...player.world.decisions.values()];
    // The verdict judged the batch the change was in, and the bounce names it: it is the change's to show.
    // Its classed evidence is read from Keel's view of the verdict, when the change's page is opened.
    expect(changePageOf(player.world, h?.id ?? "", player)?.verdict?.evidence).toEqual([]);
    player.wantVerdict(h?.id ?? "");
    await Promise.resolve();
    await Promise.resolve();
    const file = changePageOf(player.world, h?.id ?? "", player);
    expect(file?.change.state).toBe("bounced");
    expect(file?.verdict).toMatchObject({ outcome: "bounce" });
    expect(file?.bounce?.cites).toBe(decision?.id);
    expect(player.world.citing.get(decision?.id ?? "")).toEqual([h?.id]);
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

  it("[s2.as-keel-commits] tells the guard's bounce in the events Keel commits and in its words, and in no other", () => {
    const events = generateS2(42).events;
    const of = <Type extends AnyEvent["type"]>(type: Type) =>
      events.filter((event): event is Extract<AnyEvent, { type: Type }> => event.type === type);
    // A failing guard is a line of its batch's verdict. Keel commits no event for it, opens no conflict from
    // it, and says nothing of a tenet: history's one conflict is the only one, and its resolution the only one.
    expect(of("GuardFailed")).toEqual([]);
    expect(of("TenetContested")).toEqual([]);
    expect(of("TenetReaffirmed")).toEqual([]);
    expect(of("ConflictSuspected")).toHaveLength(1);
    expect(of("ConflictResolved").map((event) => event.payload.move)).toEqual(["refine"]);
    const bounce = of("ChangeBounced").at(-1)?.payload;
    const verdict = of("VerdictIssued").find(
      (event) => event.payload.verdictId === bounce?.verdictId,
    )?.payload;
    const failed = of("BatchFailed").at(-1)?.payload;
    // The verdict judged a batch, the batch's failure blames its one member, and the bounce names that verdict.
    expect(verdict).toMatchObject({ subject: failed?.batchId, outcome: "bounce" });
    expect(failed).toMatchObject({ verdictId: verdict?.verdictId, attribution: bounce?.changeId });
    expect(bounce?.reasons).toEqual(verdict?.evidence);
    expect(bounce?.nextActions).toEqual(verdict?.nextActions);
    // Keel's citation: the guard that failed, and the decision it holds in that decision's own summary.
    const [guard] = of("GuardAdmitted");
    const [decision] = of("DecisionRecorded");
    expect(decision?.payload.summary).toBe(S2_DECIDED);
    expect(bounce?.reasons.at(-1)).toMatch(
      new RegExp(
        `^guard failed: guard:${guard?.payload.guardId} \\(freshness\\): .+; it holds decision ${decision?.payload.decisionId}: ${S2_DECIDED}$`,
      ),
    );
    expect(bounce?.nextActions?.map((action) => [action.operationId, action.args])).toEqual([
      ["submit", { failingGuards: [bounce?.reasons.at(-1)?.replace("guard failed: ", "")] }],
      ["Memory_getDecision", { decisionId: decision?.payload.decisionId }],
    ]);
    expect(bounce?.nextActions?.[1]?.title).toBe(
      `Read decision ${decision?.payload.decisionId}, which the failed guard holds: ${S2_DECIDED}`,
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
    // As a live Keel publishes it: events, and nothing of the console's own beside them. Keel's domain has an
    // event for a guard that failed in a change's own plan and commits none yet, so one is written here by hand.
    const bare = new World();
    const { items } = await createMockSource({ scenario: "s2", seed: 42 }).readEvents({
      limit: 500,
    });
    for (const event of items) bare.apply(event, 0);
    const h = [...bare.changes.values()].find((change) => change.label === "#1205");
    const admitted = items.find((event) => event.type === "GuardAdmitted");
    const last = items.at(-1);
    if (admitted?.type !== "GuardAdmitted" || last === undefined || h === undefined)
      throw new Error("scenario 2 admits no guard, or bounces no change");
    bare.apply(
      {
        ...last,
        type: "GuardFailed",
        entity: { kind: "change", id: h.id },
        payload: {
          _tag: "GuardFailed",
          guardId: admitted.payload.guardId,
          changeId: h.id,
          world: "A",
        },
      },
      0,
    );
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
