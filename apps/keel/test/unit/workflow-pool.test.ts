// A Workflow's warm pool, by its rules alone: each warm instance goes to one
// claim, the same event is always answered the same, an instance near its end
// is never handed out, an empty pool answers cold and remembers it, and the
// pool starts instances and sets its deadline as its counts say.
import { describe, expect, it } from "vitest";
import {
  added,
  COLD,
  claim,
  EMPTY_POOL,
  nextDeadline,
  POOL_LOW_WATER,
  CLAIM_MEMORY_MS,
  POOL_WAIT_MS,
  type PoolState,
  RETIRE_MARGIN_MS,
  toStart,
  warmTarget,
} from "../../src/adapters/driving/do/workflow-pool-rules.ts";

const T0 = 1_760_000_000_000;

/** The target keel.town's wrangler config sets. */
const TARGET = 4;

const pool = (ids: readonly string[], at = T0): PoolState => added(EMPTY_POOL, ids, at);

const ids = (n: number) => Array.from({ length: n }, (_, i) => `wf-${i}`);

describe("the warm pool's rules", () => {
  it("[workflow-pool.claim-once] hands each warm instance to one claim, the one nearest its end first, then answers cold", () => {
    let state = added(pool(["wf-b"], T0 + 1_000), ["wf-a"], T0);
    const first = claim(state, "evt_1", undefined, T0 + 2_000);
    state = first.state;
    const second = claim(state, "evt_2", undefined, T0 + 3_000);
    state = second.state;
    const third = claim(state, "evt_3", undefined, T0 + 4_000);
    expect([first.answer, second.answer, third.answer]).toEqual(["wf-a", "wf-b", COLD]);
    expect(third.state.warm).toEqual([]);
    expect([first.kept, second.kept, third.kept]).toEqual([
      { eventId: "evt_1", answer: "wf-a", forgetAt: T0 + 2_000 + CLAIM_MEMORY_MS },
      { eventId: "evt_2", answer: "wf-b", forgetAt: T0 + 3_000 + CLAIM_MEMORY_MS },
      { eventId: "evt_3", answer: COLD, forgetAt: T0 + 4_000 + CLAIM_MEMORY_MS },
    ]);
  });

  it("[workflow-pool.claim-again] answers a redelivered event as it was answered first, warm or cold, and takes nothing more from the pool", () => {
    const warm = claim(pool(["wf-a", "wf-b"]), "evt_1", undefined, T0 + 1);
    const again = claim(warm.state, "evt_1", warm.answer, T0 + 60_000);
    expect(again.answer).toBe("wf-a");
    expect(again.state.warm.map((w) => w.id)).toEqual(["wf-b"]);
    expect(again.kept).toBeUndefined();

    const cold = claim(EMPTY_POOL, "evt_2", undefined, T0);
    const refilled = added(cold.state, ["wf-c"], T0 + 1);
    const coldAgain = claim(refilled, "evt_2", cold.answer, T0 + 2);
    expect(coldAgain.answer).toBe(COLD);
    expect(coldAgain.state.warm.map((w) => w.id)).toEqual(["wf-c"]);
    expect(coldAgain.kept).toBeUndefined();
  });

  it("[workflow-pool.near-retire] never hands out an instance within the margin of its end, which retires on its own", () => {
    const end = T0 + POOL_WAIT_MS;
    const lastUsable = end - RETIRE_MARGIN_MS - 1;
    expect(claim(pool(["wf-a"]), "evt_1", undefined, lastUsable).answer).toBe("wf-a");
    const late = claim(pool(["wf-a"]), "evt_1", undefined, lastUsable + 1);
    expect(late.answer).toBe(COLD);
    expect(late.state.warm).toEqual([]);
  });

  it("[workflow-pool.claims-expire] keeps a claim until its warm instance has surely retired: the outbox redelivers until taken, so the pool's wait is the bound", () => {
    // 24 hours, written out: the instance a claim names was created before it and waits this long at most.
    expect(CLAIM_MEMORY_MS).toBe(24 * 60 * 60_000);
    expect(CLAIM_MEMORY_MS).toBeGreaterThanOrEqual(POOL_WAIT_MS);
    const first = claim(pool(["wf-a"]), "evt_1", undefined, T0);
    expect(first.kept?.forgetAt).toBe(T0 + 24 * 60 * 60_000);
  });

  it("[workflow-pool.refill] after a claim starts up to the target only below the low-water mark; at the deadline tops up whatever is left", () => {
    expect(POOL_LOW_WATER).toBe(2);
    expect(toStart(EMPTY_POOL, T0, "claim", TARGET)).toBe(4);
    expect(toStart(pool(ids(1)), T0, "claim", TARGET)).toBe(3);
    expect(toStart(pool(ids(2)), T0, "claim", TARGET)).toBe(0);
    expect(toStart(pool(ids(2)), T0, "deadline", TARGET)).toBe(2);
    expect(toStart(pool(ids(5)), T0, "deadline", TARGET)).toBe(0);
    // Instances past their margin count for nothing: they retire on their own.
    const late = T0 + POOL_WAIT_MS - RETIRE_MARGIN_MS;
    expect(toStart(pool(ids(4)), late, "claim", TARGET)).toBe(4);
    // A pool that keeps none starts none, whatever is left.
    expect(toStart(EMPTY_POOL, T0, "claim", 0)).toBe(0);
    expect(toStart(EMPTY_POOL, T0, "deadline", 0)).toBe(0);
  });

  it("[workflow-pool.target] keeps the whole number its deployment sets, and none for anything else or nothing", () => {
    expect(warmTarget("4")).toBe(4);
    expect(warmTarget("1")).toBe(1);
    expect(["0", "-2", "2.5", "four", "", undefined].map(warmTarget)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("[workflow-pool.deadline] acts next when its first instance stops being handed out, and never for an empty pool", () => {
    expect(nextDeadline(EMPTY_POOL)).toBeUndefined();
    const state = added(pool(["wf-late"], T0 + 5_000), ["wf-early"], T0);
    expect(nextDeadline(state)).toBe(T0 + POOL_WAIT_MS - RETIRE_MARGIN_MS);
  });
});
