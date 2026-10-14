import { describe, expect, it, vi } from "vitest";
import { ScriptBuilder } from "../../fixtures/mock/builder.ts";
import { createMockSource, type Scenario } from "../../fixtures/mock/MockSource.ts";
import { generateSwarm } from "../../fixtures/mock/swarm.ts";
import { createRng } from "../../fixtures/prng.ts";
import type { AnyEvent } from "../../../src/contract/events.ts";
import {
  type ChangeRow,
  type ChangeStage,
  type FunnelRow,
  type FunnelState,
  bouncesIn,
  changeFunnelOf,
  funnelOf,
} from "../../../src/engine/funnel.ts";
import type { Player } from "../../../src/engine/player.ts";
import { World } from "../../../src/engine/world.ts";
import { showing } from "../showing.ts";

// A test here replays the whole swarm. On a busy machine that takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

async function playerAt(scenario: Scenario, seconds: number, ruling?: string): Promise<Player> {
  const player = showing(
    createMockSource({ scenario, seed: 42, ...(ruling === undefined ? {} : { ruling }) }),
  );
  await player.load();
  player.seek(seconds * 1000);
  return player;
}

function row(state: FunnelState, stage: FunnelRow["stage"]): FunnelRow | undefined {
  return state.rows.find((candidate) => candidate.stage === stage);
}

describe("the review funnel, read off the swarm", () => {
  // One replay serves every test that reads the end of the run.
  const finished = playerAt("swarm", 9999);

  it("[funnel.probe] ends with almost everything settled before a model is asked, and two questions for a person", async () => {
    const state = funnelOf((await finished).world);
    expect(state.rows.map((entry) => entry.stage)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(state.changesCompared).toBe(1876);
    // Each change could have been compared with over a thousand premises, in flight or landed; the subject index passed on two or three.
    expect(state.perChange?.everything).toBeGreaterThan(1000);
    expect(state.perChange?.compared).toBeGreaterThan(2);
    expect(state.perChange?.compared).toBeLessThan(3);
    expect(state.settledBeforeModels).toBeGreaterThan(0.999);
    // A proof settles no conflict by itself: Keel bounces the change on it, and the conflict stays proven, which
    // is open as Keel counts it, until a ruling resolves it. So the probe settles only the false alarms it
    // dismissed, and passes on the two put to a person; the ten it proved are still here.
    expect(row(state, 4)).toMatchObject({
      reported: true,
      reached: 20,
      settled: 8,
      passedOn: 2,
      open: 10,
      dismissed: 8,
      proven: 10,
    });
    expect(row(state, 5)).toMatchObject({
      reported: true,
      reached: 2,
      settled: 2,
      passedOn: 0,
      open: 0,
    });
    expect(row(state, 5)?.usd).toBeUndefined();
    expect(state).toMatchObject({ changesLanded: 1613, peopleAsked: 2, peopleWaiting: 0 });
    expect(state.medianAnswerMs).toBeGreaterThan(14_000);
  });

  it("joins the platform's counters to the events: what the code model passed on is what reached the probe", async () => {
    const state = funnelOf((await finished).world);
    expect(row(state, 3)?.passedOn).toBe(row(state, 4)?.reached);
    expect(row(state, 4)?.passedOn).toBe(row(state, 5)?.reached);
    // Twelve probes that proved their conflict ran all fifteen cells: three runs in the four worlds and the control.
    // Eight false alarms stopped at thirteen, at the first complete run that did not discriminate.
    expect(row(state, 4)?.usd).toBeCloseTo((12 * 15 + 8 * 13) * 0.000064, 9);
    expect(state.usd).toBeCloseTo(
      state.rows.reduce((sum, entry) => sum + (entry.usd ?? 0), 0),
      9,
    );
  });

  it("accounts for every comparison at every instant: settled, passed on, or still open", async () => {
    const player = await playerAt("swarm", 0);
    const seen = [20, 40, 53, 60, 80, 95, 120].map((second) => {
      player.seek(second * 1000);
      return funnelOf(player.world);
    });
    const adrift = seen.flatMap((state) =>
      state.rows.filter(
        (entry) => entry.open < 0 || entry.reached !== entry.settled + entry.passedOn + entry.open,
      ),
    );
    expect(adrift).toEqual([]);
    // Somewhere in the run a probe is still deciding.
    expect(seen.some((state) => (row(state, 4)?.open ?? 0) > 0)).toBe(true);
  });

  it("reports nothing, rather than zero, for the levels a source keeps no count of", () => {
    const log = generateSwarm(42);
    const world = new World();
    log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
    const state = funnelOf(world);
    expect(state.rows.slice(0, 4).map((entry) => entry.reported)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(state.rows.slice(0, 4).map((entry) => entry.usd)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(state.changesCompared).toBeUndefined();
    expect(state.perChange).toBeUndefined();
    expect(state.settledBeforeModels).toBeUndefined();
    // Probes and questions are events, so they are still counted.
    expect(row(state, 4)).toMatchObject({ reported: true, reached: 20, settled: 8, passedOn: 2 });
    expect(state.usd).toBeCloseTo(row(state, 4)?.usd ?? -1, 9);
  });
});

describe("the review funnel, read off a log as Keel writes it", () => {
  it("[funnel.no-cost] shows no cost where the log carries none: that is not a cost of nothing", async () => {
    // Keel records no cost yet. Its events are the fixture's without what the fixture adds to them, and it
    // sends no observation.
    const scripted = createMockSource({ scenario: "s1", seed: 42 });
    const player = showing({
      ...scripted,
      async readEvents(request = {}) {
        const page = await scripted.readEvents(request);
        return {
          ...page,
          items: page.items.map((event) => {
            const { x: _added, ...payload } = event.payload as { x?: unknown };
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the same event, less the fixture's own additions
            return { ...event, payload } as typeof event;
          }),
        };
      },
      readObservations: (request = {}) =>
        Promise.resolve({ items: [], nextCursor: request.cursor ?? "" }),
    });
    await player.load();
    player.seek(player.end);
    const state = funnelOf(player.world);
    // The probe is counted, from its events.
    expect(row(state, 4)).toMatchObject({ reported: true, reached: 1 });
    expect(row(state, 4)).not.toHaveProperty("usd");
    expect(state).not.toHaveProperty("usd");
    expect(state.changesLanded).toBeGreaterThan(0);
  });
});

describe("the review funnel, read off the scripted scenarios", () => {
  it("shows a question waiting for a person, and then answered", async () => {
    const player = await playerAt("s1", 9999, "live");
    const held = funnelOf(player.world);
    expect(row(held, 4)).toMatchObject({ reached: 1, settled: 0, passedOn: 1, open: 0 });
    expect(row(held, 5)).toMatchObject({ reached: 1, settled: 0, open: 1 });
    expect(held).toMatchObject({ peopleAsked: 1, peopleWaiting: 1 });
    expect(held.medianAnswerMs).toBeUndefined();

    await player.rule([...player.world.escalations.keys()][0] ?? "", "invalidate");
    const ruled = funnelOf(player.world);
    expect(row(ruled, 5)).toMatchObject({ reached: 1, settled: 1, open: 0 });
    expect(ruled.peopleWaiting).toBe(0);
  });

  it("keeps a conflict with the code model until its probe is drafted", async () => {
    const state = funnelOf((await playerAt("s1", 398)).world);
    expect(row(state, 3)).toMatchObject({ reached: 1, passedOn: 0, open: 1 });
    expect(row(state, 4)).toMatchObject({ reached: 0, open: 0 });
  });

  it("counts a probe as open while its world matrix is filling", async () => {
    const state = funnelOf((await playerAt("s1", 443)).world);
    expect(row(state, 3)).toMatchObject({ reached: 1, passedOn: 1 });
    expect(row(state, 4)).toMatchObject({ reached: 1, settled: 0, passedOn: 0, open: 1 });
    expect(row(state, 5)).toMatchObject({ reached: 0, open: 0 });
  });

  it("counts nothing for a guard that bounces a change: it opens no conflict, no probe and no question", async () => {
    const state = funnelOf((await playerAt("s2", 9999)).world);
    // History holds the one conflict, which went to a person. The guard's failure is a line of a verdict.
    expect(row(state, 3)).toMatchObject({ reached: 1, passedOn: 1 });
    expect(row(state, 4)).toMatchObject({ reached: 1, passedOn: 1, proven: 0, dismissed: 0 });
    expect(row(state, 5)).toMatchObject({ reached: 1, settled: 1 });
    // The first probe's fifteen runs, and nothing beside them.
    expect(row(state, 4)?.usd).toBeCloseTo(15 * 0.00014, 9);
  });
});

const on = (id: string) => ({ kind: "change" as const, id });
const batchOf = (n: number) => ({ kind: "batch" as const, id: `bat_${n}` });

/**
 * A log written by hand, in which Keel's own events, in Keel's own order, take each change to one known place.
 * A plan is compiled and the change queued in one step, as Keel commits them; a batch is one change, and what
 * says a change was verified is its batch's `BatchVerified`.
 */
function handWritten(): World {
  const b = new ScriptBuilder("2026-10-13T16:00:00.000Z", createRng(5));
  b.at(0);
  const declared = new Set<string>();
  const declare = (id: string): void => {
    b.after(1).emit({
      type: "IntentDeclared",
      entity: on(id),
      payload: {
        changeId: id,
        agentId: "agt_1",
        origin: "agent",
        revision: 1,
        goal: id,
        footprint: [],
        premises: [],
        leaseId: "l",
      },
    });
    b.emit({
      type: "ChangeStarted",
      entity: on(id),
      payload: { changeId: id, workspaceId: `ws_${id}` },
    });
  };
  const precheck = (id: string, revision = 1): void => {
    if (!declared.has(id)) declare(id);
    declared.add(id);
    b.after(1).emit({
      type: "ChangeSubmitted",
      entity: on(id),
      payload: {
        changeId: id,
        revision,
        commitSha: `c-${id}-${revision}`,
        workspaceId: `ws_${id}`,
      },
    });
    b.emit({
      type: "PrecheckStarted",
      entity: on(id),
      payload: { changeId: id, revision, instanceId: `pre-${id}-${revision}` },
    });
  };
  const plan = (id: string, costEstimate: number, revision = 1): void => {
    precheck(id, revision);
    b.after(1).emit({
      type: "PlanCompiled",
      entity: on(id),
      payload: {
        changeId: id,
        revision,
        planHash: `sha256:${id}-${revision}`,
        steps: 3,
        costEstimate,
      },
    });
    b.emit({ type: "ChangeQueued", entity: on(id), payload: { changeId: id, laneId: "lane_1" } });
  };
  const batch = (id: string, n: number): void => {
    b.after(1).emit({
      type: "BatchFormed",
      entity: batchOf(n),
      payload: {
        batchId: `bat_${n}`,
        laneId: "lane_1",
        members: [id],
        base: "base",
        attempt: 1,
        chainEpoch: 1,
      },
    });
    b.emit({
      type: "ChangeBatched",
      entity: on(id),
      payload: { changeId: id, batchId: `bat_${n}` },
    });
  };
  const pass = (n: number, flag: { verified?: boolean } = {}): void => {
    b.after(1).emit({
      type: "BatchVerified",
      entity: batchOf(n),
      payload: { batchId: `bat_${n}`, candidateId: `cnd_${n}`, verdictId: `vrd_${n}`, ...flag },
    });
  };
  const land = (id: string, n: number): void => {
    b.after(1).emit({
      type: "ChangeLanded",
      entity: on(id),
      payload: {
        changeId: id,
        commitSha: `c-${id}`,
        trunkSha: `t-${n}`,
        candidateId: `cnd_${n}`,
        proofId: `prf_${n}`,
      },
    });
  };
  const bounce = (
    id: string,
    cause:
      | { verdictId: string }
      | { conflictId: string }
      | { declined: { batchId: string; reason: "pack-too-large" } }
      | { decisionId: string },
  ): void => {
    b.after(1).emit({
      type: "ChangeBounced",
      entity: on(id),
      payload: { changeId: id, reasons: ["r"], ...cause },
    });
  };
  const revise = (id: string, revision: number): void => {
    b.after(1).emit({
      type: "IntentRevised",
      entity: on(id),
      payload: { changeId: id, revision, premisesAdded: [], premisesRetracted: [] },
    });
  };

  // Told to Keel, and nothing since.
  declare("chg_idle");
  // Withdrawn before it was ever submitted.
  declare("chg_gone");
  b.after(1).emit({
    type: "ChangeWithdrawn",
    entity: on("chg_gone"),
    payload: { changeId: "chg_gone", by: "agt_1" },
  });
  // Its precheck is running.
  precheck("chg_checking");
  // Refused at precheck: a verdict on the change itself, and the bounce that names it.
  precheck("chg_refused");
  bounce("chg_refused", { verdictId: "vrd_refused" });
  // A conflict proven against it, under a plan that blocks on the predicate.
  plan("chg_clash", 0.02);
  bounce("chg_clash", { conflictId: "cfl_1" });
  // And the other side of that conflict, bounced on it too: two on a conflict here, and one on a verdict.
  plan("chg_clash_too", 0.02);
  bounce("chg_clash_too", { conflictId: "cfl_1" });
  // Parked in the queue while a person is asked.
  plan("chg_held", 0.005);
  b.after(1).emit({
    type: "ChangeParked",
    entity: on("chg_held"),
    payload: { changeId: "chg_held", reason: "awaiting-ruling", escalationId: "esc_1" },
  });
  // Waited for a ruling at its precheck, and the ruling went against it.
  precheck("chg_ruled");
  b.after(1).emit({
    type: "ChangeParked",
    entity: on("chg_ruled"),
    payload: { changeId: "chg_ruled", reason: "awaiting-ruling", escalationId: "esc_1" },
  });
  bounce("chg_ruled", { decisionId: "dec_1" });
  // Verified and landed.
  plan("chg_done", 0.03);
  batch("chg_done", 1);
  pass(1);
  land("chg_done", 1);
  // Landed in a project whose verification is off: Keel passes the batch and says the plan was not run.
  plan("chg_unchecked", 0.01);
  batch("chg_unchecked", 2);
  pass(2, { verified: false });
  land("chg_unchecked", 2);
  // Its batch failed on it; it came back, was verified, and is in the queue again after its batch was invalidated.
  plan("chg_again", 0.04);
  batch("chg_again", 3);
  bounce("chg_again", { verdictId: "vrd_3" });
  revise("chg_again", 2);
  plan("chg_again", 0.04, 2);
  batch("chg_again", 4);
  pass(4);
  b.after(1).emit({
    type: "ChangeRequeued",
    entity: on("chg_again"),
    payload: { changeId: "chg_again", batchId: "bat_4", reason: "invalidated" },
  });
  // Verified, and then its batch's push was refused.
  plan("chg_too_big", 0.02);
  batch("chg_too_big", 5);
  pass(5);
  bounce("chg_too_big", { declined: { batchId: "bat_5", reason: "pack-too-large" } });
  // Verified, its batch's push refused, and now at its precheck again: still one that was verified.
  plan("chg_round", 0.02);
  batch("chg_round", 7);
  pass(7);
  bounce("chg_round", { declined: { batchId: "bat_7", reason: "pack-too-large" } });
  revise("chg_round", 2);
  precheck("chg_round", 2);
  // Bounced on a conflict, revised, verified and landed.
  plan("chg_back", 0.01);
  bounce("chg_back", { conflictId: "cfl_2" });
  revise("chg_back", 2);
  plan("chg_back", 0.01, 2);
  batch("chg_back", 6);
  pass(6);
  land("chg_back", 6);

  const world = new World();
  const log = b.build();
  log.events.forEach((event, index) => world.apply(event, log.eventTimes[index] ?? 0));
  return world;
}

const NONE = {
  verdict: 0,
  conflict: 0,
  declined: 0,
  ruling: 0,
  drifted: 0,
  withdrawn: 0,
  superseded: 0,
};
const stageOf = (rows: readonly ChangeRow[], stage: ChangeStage): ChangeRow | undefined =>
  rows.find((candidate) => candidate.stage === stage);

describe("the funnel of changes, on a log written by hand", () => {
  const funnel = changeFunnelOf(handWritten());

  it("[funnel.stages] counts at each stage the changes Keel's events took that far, and where each that got no further stands", () => {
    expect(funnel.rows.map((entry) => entry.stage)).toEqual([
      "declared",
      "precheck",
      "verified",
      "landed",
    ]);
    expect(stageOf(funnel.rows, "declared")).toEqual({
      stage: "declared",
      reached: 14,
      wentOn: 12,
      here: 1,
      parked: 0,
      out: { ...NONE, withdrawn: 1 },
    });
    expect(stageOf(funnel.rows, "precheck")).toMatchObject({ reached: 12, wentOn: 6, here: 2 });
    expect(stageOf(funnel.rows, "verified")).toMatchObject({ reached: 5, wentOn: 2, here: 2 });
    expect(stageOf(funnel.rows, "landed")).toMatchObject({ reached: 3 });
    expect(funnel).toMatchObject({ declared: 14, landed: 3 });
  });

  it("[funnel.once] counts a change that came round again once at each stage, and leaves it where it got to", () => {
    // Three changes were prechecked twice: twelve changes reached the precheck in fifteen prechecks.
    expect(stageOf(funnel.rows, "precheck")?.reached).toBe(12);
    // One was verified at its second attempt and is queued again. One was verified, had its batch's push
    // refused and is at its precheck again. Each is still one that was verified, and is not back at the precheck.
    expect(stageOf(funnel.rows, "verified")).toMatchObject({ reached: 5, here: 2, parked: 0 });
    expect(stageOf(funnel.rows, "precheck")?.here).toBe(2);
  });

  it("[funnel.cause] puts a bounced change under the one cause Keel named, at the stage it had got to", () => {
    // Two stand bounced on a conflict and one on a verdict: were the causes mixed up, the two would change places.
    // One more stands bounced on a ruling, which is none of the other three.
    expect(stageOf(funnel.rows, "precheck")?.out).toEqual({
      ...NONE,
      verdict: 1,
      conflict: 2,
      ruling: 1,
    });
    expect(stageOf(funnel.rows, "verified")?.out).toEqual({ ...NONE, declined: 1 });
    // Every bounce in the log, the ones a change came back from among them.
    expect(funnel.bounces).toEqual({ verdict: 2, conflict: 3, declined: 2, ruling: 1 });
    expect(bouncesIn(funnel.bounces)).toBe(8);
    expect(funnel).toMatchObject({ bounced: 8, bouncedThenLanded: 1 });
  });

  it("[funnel.parked] keeps a change Keel has parked at its stage, and says it is parked", () => {
    expect(stageOf(funnel.rows, "precheck")).toMatchObject({ here: 2, parked: 1 });
  });

  it("[funnel.unverified] does not count as verified a change that landed where verification was off", () => {
    expect(stageOf(funnel.rows, "landed")?.reached).toBe(3);
    // Three landed and two of those were verified; the other three verified changes have not landed.
    expect(stageOf(funnel.rows, "verified")).toMatchObject({ reached: 5, wentOn: 2 });
    expect(funnel.landedUnverified).toBe(1);
  });

  it("[funnel.estimate] adds up Keel's estimates for the plans it compiled, and never into what was spent", () => {
    const state = funnelOf(handWritten());
    expect(state.estimate?.plans).toBe(11);
    expect(state.estimate?.usd).toBeCloseTo(0.225, 9);
    // No event of this log carries a cost. An estimate is not one.
    expect(state).not.toHaveProperty("usd");
    for (const entry of state.rows) expect(entry).not.toHaveProperty("usd");
  });

  it("[funnel.no-estimate] says nothing of an estimate where Keel compiled no plan: that is not an estimate of nothing", () => {
    expect(funnelOf(new World())).not.toHaveProperty("estimate");
  });

  it("[funnel.public] counts the same changes for a reader who is not shown the questions: every stage's event is public", () => {
    const world = handWritten();
    expect(funnelOf(world, false).changes).toEqual(funnelOf(world, true).changes);
  });
});

/** A fixture's whole log, as its source reads it out. */
async function logOf(scenario: Scenario): Promise<AnyEvent[]> {
  const source = createMockSource({ scenario, seed: 42 });
  const events: AnyEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a page names the next one
    const read = await source.readEvents(cursor === undefined ? {} : { cursor });
    events.push(...read.items);
    if (read.items.length === 0) break;
    cursor = read.nextCursor;
  }
  return events;
}

describe("the funnel of changes, held to each fixture's own log", () => {
  it.each(["s1", "s2", "s3", "s4", "s5", "swarm"] as const)(
    "[funnel.whole] in %s, a stage is the changes its event names, and every change is in one place",
    async (scenario) => {
      const events = await logOf(scenario);
      // Counted here from the log itself, with no fold between: the changes each stage's own event names.
      const named = (type: AnyEvent["type"]): Set<string> =>
        new Set(
          events.flatMap((event) =>
            event.type === type &&
            "changeId" in event.payload &&
            event.payload.changeId !== undefined
              ? [event.payload.changeId]
              : [],
          ),
        );
      const members = new Map<string, string[]>();
      const verified = new Set<string>();
      for (const event of events) {
        if (event.type === "BatchFormed") members.set(event.payload.batchId, event.payload.members);
        if (event.type === "BatchVerified" && event.payload.verified !== false)
          for (const member of members.get(event.payload.batchId) ?? []) verified.add(member);
      }
      const funnel = changeFunnelOf((await playerAt(scenario, 9999)).world);
      const reached = (stage: ChangeStage): number | undefined =>
        stageOf(funnel.rows, stage)?.reached;
      expect(reached("declared")).toBe(named("IntentDeclared").size);
      expect(reached("declared")).toBeGreaterThan(0);
      expect(reached("precheck")).toBe(named("PrecheckStarted").size);
      expect(reached("verified")).toBe(verified.size);
      expect(reached("landed")).toBe(named("ChangeLanded").size);
      // Every change stands in exactly one place: landed, or at the last stage it reached.
      const placed = funnel.rows.reduce(
        (sum, entry) =>
          sum + entry.here + Object.values(entry.out).reduce((left, n) => left + n, 0),
        reached("landed") ?? 0,
      );
      expect(placed).toBe(funnel.declared);
      for (const entry of funnel.rows.slice(0, 3))
        expect(entry.reached).toBe(
          entry.wentOn + entry.here + Object.values(entry.out).reduce((left, n) => left + n, 0),
        );
      // And every bounce in the log is counted under a cause.
      const bounces = events.filter((event) => event.type === "ChangeBounced").length;
      expect(bouncesIn(funnel.bounces)).toBe(bounces);
    },
  );
});
