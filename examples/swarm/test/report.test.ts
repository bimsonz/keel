import { describe, expect, it } from "vitest";
import { CEILINGS, NO_SLOTS, give, take, type Ceilings } from "../src/run/ceilings.ts";
import { percentile, summarise, table, type WorkerRecord } from "../src/run/report.ts";

const worker = (over: Partial<WorkerRecord> & Pick<WorkerRecord, "index">): WorkerRecord => ({
  kind: "disjoint",
  outcome: "landed",
  bounces: 0,
  ...over,
});

describe("the report", () => {
  it("[swarm.report-numbers] gives contention, rework and time in queue from the workers' records", () => {
    const records: WorkerRecord[] = [
      worker({ index: 0, changeId: "c0", neighbours: 0, submittedAt: 0, landedAt: 10_000 }),
      worker({
        index: 1,
        changeId: "c1",
        neighbours: 2,
        bounces: 1,
        submittedAt: 0,
        landedAt: 20_000,
      }),
      worker({
        index: 2,
        changeId: "c2",
        neighbours: 1,
        bounces: 2,
        submittedAt: 5_000,
        landedAt: 45_000,
      }),
      worker({ index: 3, changeId: "c3", neighbours: 3, bounces: 2, outcome: "bounced" }),
      worker({ index: 4, outcome: "failed" }),
    ];
    const r = summarise(records, 25);
    expect(r).toMatchObject({
      workers: 5,
      declared: 4,
      landed: 3,
      notLanded: 2,
      bounces: 5,
      modelCalls: 25,
    });
    // Three of the four declared changes had a neighbour; the worker that never declared isn't counted.
    expect(r.contentionDensity).toBe(0.75);
    // Bounces per landing, every bounce counted, the unlanded worker's too.
    expect(r.reworkRate).toBeCloseTo(5 / 3);
    expect(r.queueMs).toEqual({ p50: 20_000, p95: 40_000 });
    expect(r.modelCallsPerLanding).toBeCloseTo(25 / 3);
  });

  it("[swarm.report-empty] says n/a, never a number, where nothing landed or declared", () => {
    const r = summarise([worker({ index: 0, outcome: "failed" })], 3);
    expect(r).toMatchObject({
      contentionDensity: null,
      reworkRate: null,
      queueMs: { p50: null, p95: null },
    });
    expect(table([{ title: "(a) 5", report: r }])).toContain("| Contention density | n/a |");
  });

  it("[swarm.report-percentile] takes the nearest rank", () => {
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 1_000);
    expect(percentile(values.toReversed(), 50)).toBe(10_000);
    expect(percentile(values, 95)).toBe(19_000);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("the model's ceilings", () => {
  const small: Ceilings = { inFlight: 2, perRun: 3, holdMs: 1_000 };

  it("[swarm.ceilings] holds calls in flight and a run's calls to their ceilings", () => {
    let slots = NO_SLOTS;
    const first = take(slots, "a", 0, small);
    expect(first.granted).toBe(true);
    slots = first.slots;
    slots = take(slots, "b", 0, small).slots;
    const third = take(slots, "c", 0, small);
    expect(third).toMatchObject({ granted: false, reason: "busy" });
    slots = give(third.slots, "a");
    const again = take(slots, "c", 0, small);
    expect(again.granted).toBe(true);
    slots = give(give(again.slots, "b"), "c");
    expect(take(slots, "d", 0, small)).toMatchObject({ granted: false, reason: "spent" });
  });

  it("[swarm.ceilings-lapse] lets a slot its holder never gave back lapse", () => {
    let slots = take(NO_SLOTS, "a", 0, small).slots;
    slots = take(slots, "b", 0, small).slots;
    expect(take(slots, "c", 999, small).granted).toBe(false);
    expect(take(slots, "c", 1_001, small).granted).toBe(true);
  });

  it("[swarm.ceilings-agreed] are the agreed ones: 20 in flight", () => {
    expect(CEILINGS.inFlight).toBe(20);
    expect(CEILINGS.perRun).toBe(2_500);
  });
});
