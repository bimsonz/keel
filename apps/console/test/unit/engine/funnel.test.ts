import { describe, expect, it, vi } from "vitest";
import { createMockSource } from "../../fixtures/mock/MockSource.ts";
import { generateSwarm } from "../../fixtures/mock/swarm.ts";
import { type FunnelRow, type FunnelState, funnelOf } from "../../../src/engine/funnel.ts";
import type { Player } from "../../../src/engine/player.ts";
import { World } from "../../../src/engine/world.ts";
import { showing } from "../showing.ts";

// A test here replays the whole swarm. On a busy machine that takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

async function playerAt(
  scenario: "s1" | "s2" | "swarm",
  seconds: number,
  ruling?: string,
): Promise<Player> {
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

  it("ends with almost everything settled before a model is asked, and two questions for a person", async () => {
    const state = funnelOf((await finished).world);
    expect(state.rows.map((entry) => entry.stage)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(state.changesCompared).toBe(1876);
    // Each change could have been compared with over a thousand premises, in flight or landed; the subject index passed on two or three.
    expect(state.perChange?.everything).toBeGreaterThan(1000);
    expect(state.perChange?.compared).toBeGreaterThan(2);
    expect(state.perChange?.compared).toBeLessThan(3);
    expect(state.settledBeforeModels).toBeGreaterThan(0.999);
    expect(row(state, 4)).toMatchObject({
      reported: true,
      reached: 20,
      settled: 18,
      passedOn: 2,
      open: 0,
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
    expect(row(state, 4)).toMatchObject({ reported: true, reached: 20, settled: 18, passedOn: 2 });
    expect(state.usd).toBeCloseTo(row(state, 4)?.usd ?? -1, 9);
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

  it("counts a guard that bounces a change as proof, with no new probe and no new question", async () => {
    const state = funnelOf((await playerAt("s2", 9999)).world);
    // History holds the first conflict, which went to a person; the guard settled the second by itself.
    expect(row(state, 3)).toMatchObject({ reached: 1, passedOn: 1 });
    expect(row(state, 4)).toMatchObject({
      reached: 2,
      settled: 1,
      passedOn: 1,
      proven: 1,
      dismissed: 0,
    });
    expect(row(state, 5)).toMatchObject({ reached: 1, settled: 1 });
    // The first probe's fifteen runs, and the guard's one run against the careless change.
    expect(row(state, 4)?.usd).toBeCloseTo(15 * 0.00014 + 0.0005, 9);
  });
});
