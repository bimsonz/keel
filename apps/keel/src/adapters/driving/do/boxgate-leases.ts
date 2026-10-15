// BoxGate's leases: how many boxes a namespace runs at once, its
// `concurrent-containers` quota. The decision is pure, so it is
// tested without the object; the object stores the leases and reclaims the
// expired ones on its alarm.

import type { BoxLeaseAnswer } from "../../../rpc/mergebox.ts";

/** A box's hold on one of its namespace's containers, until it is released or its deadline passes. */
export interface BoxLease {
  readonly id: string;
  /** Who holds it: a retried ask by the same holder renews its lease and takes no second box. */
  readonly holder: string;
  readonly expiresAt: number;
}

/** The gate's answer to an ask, as it crosses RPC. */
export type GateAnswer = BoxLeaseAnswer;

/**
 * The gate of keel-verify's Tier 2 boxes, across every namespace: each Tier 2
 * step holds a lease while its runner runs, so `BatchVerification.capacity`
 * can say how many are free. Its limit is KeelSandbox's `max_instances`.
 */
export const TIER2_GATE = "boxgate:tier2";

/** KeelSandbox's `max_instances` in keel-verify's wrangler.jsonc, which a test holds this to. */
export const TIER2_BOX_CAP = 330;

/** How long a refused ask is told to wait when no lease will end sooner: a namespace held at 0. */
const NO_ROOM_WAIT_MS = 60_000;

/** The leases still live at `now`: a lease is gone at its deadline. */
export const liveLeases = (leases: readonly BoxLease[], now: number): BoxLease[] =>
  leases.filter((lease) => lease.expiresAt > now);

/**
 * An ask by `holder` for `ttlMs`: a holder with a live lease has it renewed;
 * otherwise a lease is granted while fewer than `limit` are live, and the ask
 * is refused, with the time to the soonest deadline, when they are not.
 */
export function acquireLease(
  leases: readonly BoxLease[],
  ask: { readonly holder: string; readonly ttlMs: number; readonly id: string },
  limit: number,
  now: number,
): { readonly leases: BoxLease[]; readonly answer: GateAnswer } {
  const live = liveLeases(leases, now);
  const own = live.find((lease) => lease.holder === ask.holder);
  if (own !== undefined) {
    const renewed = { ...own, expiresAt: now + ask.ttlMs };
    return {
      leases: live.map((lease) => (lease.id === own.id ? renewed : lease)),
      answer: { granted: true, leaseId: own.id, expiresAt: renewed.expiresAt },
    };
  }
  if (live.length >= limit) {
    const soonest = nextDeadline(live);
    return {
      leases: live,
      answer: {
        granted: false,
        retryAfterMs: soonest === undefined ? NO_ROOM_WAIT_MS : Math.max(soonest - now, 1_000),
        held: live.length,
        limit,
      },
    };
  }
  const lease = { id: ask.id, holder: ask.holder, expiresAt: now + ask.ttlMs };
  return {
    leases: [...live, lease],
    answer: { granted: true, leaseId: lease.id, expiresAt: lease.expiresAt },
  };
}

/** The leases once `leaseId` is released; releasing one that is gone changes nothing. */
export const releaseLease = (leases: readonly BoxLease[], leaseId: string, now: number) =>
  liveLeases(leases, now).filter((lease) => lease.id !== leaseId);

/** When the soonest lease ends, for the alarm that reclaims it; none when none is held. */
export const nextDeadline = (leases: readonly BoxLease[]): number | undefined =>
  leases.length === 0 ? undefined : Math.min(...leases.map((lease) => lease.expiresAt));
