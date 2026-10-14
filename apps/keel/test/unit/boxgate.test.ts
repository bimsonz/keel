// BoxGate's leases: a namespace runs no more boxes at once than its limit, a
// lease ends at its deadline whether or not it is given back, and a holder
// asking again keeps the box it has.
import { describe, expect, it } from "vitest";
import {
  acquireLease,
  type BoxLease,
  nextDeadline,
  releaseLease,
} from "../../src/adapters/driving/do/boxgate-leases.ts";

const TTL = 600_000;
const T0 = 1_760_000_000_000;

/** Asks in turn, each with its own id, answering the last ask and the leases after it. */
function asks(holders: readonly string[], limit: number, now = T0, from: readonly BoxLease[] = []) {
  let leases: BoxLease[] = [...from];
  const answers = holders.map((holder, i) => {
    const step = acquireLease(
      leases,
      { holder, ttlMs: TTL, id: `lease-${holder}-${i}` },
      limit,
      now,
    );
    leases = step.leases;
    return step.answer;
  });
  return { leases, answers };
}

describe("BoxGate's leases", () => {
  it("[boxgate.limit] grants up to the limit and refuses past it, with the time to the soonest deadline; a holder asking again keeps its lease", () => {
    const { leases, answers } = asks(["cand-1", "cand-2", "cand-3"], 2);
    expect(answers.map((a) => a.granted)).toEqual([true, true, false]);
    expect(answers[2]).toEqual({ granted: false, retryAfterMs: TTL, held: 2, limit: 2 });
    expect(leases).toHaveLength(2);

    // A retried ask takes no second box: the same lease, its deadline moved on.
    const later = T0 + 60_000;
    const again = acquireLease(leases, { holder: "cand-1", ttlMs: TTL, id: "unused" }, 2, later);
    expect(again.answer).toEqual({
      granted: true,
      leaseId: "lease-cand-1-0",
      expiresAt: later + TTL,
    });
    expect(again.leases).toHaveLength(2);

    // A namespace held at 0 runs no box, and is told to come back in a minute.
    expect(asks(["cand-1"], 0).answers[0]).toEqual({
      granted: false,
      retryAfterMs: 60_000,
      held: 0,
      limit: 0,
    });
  });

  it("[boxgate.expires] a lease never given back ends at its deadline, and its box goes to the next ask", () => {
    const { leases } = asks(["cand-1", "cand-2"], 2);
    expect(nextDeadline(leases)).toBe(T0 + TTL);
    expect(asks(["cand-3"], 2, T0 + TTL - 1, leases).answers[0]?.granted).toBe(false);
    const after = asks(["cand-3"], 2, T0 + TTL, leases);
    expect(after.answers[0]).toMatchObject({ granted: true, leaseId: "lease-cand-3-0" });
    expect(after.leases.map((l) => l.holder)).toEqual(["cand-3"]);
  });

  it("[boxgate.release] a lease given back frees its box at once, and giving one back twice changes nothing", () => {
    const { leases } = asks(["cand-1", "cand-2"], 2);
    const released = releaseLease(leases, "lease-cand-1-0", T0 + 1);
    expect(released.map((l) => l.holder)).toEqual(["cand-2"]);
    expect(releaseLease(released, "lease-cand-1-0", T0 + 2)).toEqual(released);
    expect(asks(["cand-3"], 2, T0 + 3, released).answers[0]?.granted).toBe(true);
    expect(nextDeadline([])).toBeUndefined();
  });
});
