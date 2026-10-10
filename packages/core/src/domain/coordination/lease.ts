import { Result } from "effect";
import {
  type Instant,
  type LeaseId,
  type NextAction,
  Instant as instant,
} from "../kernel/index.ts";
import { type Change, type Lease, LEASE_TTL_MS } from "./change.ts";
import { LeaseStale } from "./errors.ts";

/** When the lease lapses unless it is renewed first: 15 minutes after its last renewal. */
export const lapsesAt = (lease: Lease): Instant => instant(lease.renewedAt + LEASE_TTL_MS);

/**
 * Whether the lease has lapsed at `now`. Computed on read, from `renewedAt`
 * and the time passed in: the deadline alarm only makes a lapse visible as an
 * event, so a lease is Lapsed from its deadline on whether or not it has fired.
 */
export const isLapsed = (lease: Lease, now: Instant): boolean =>
  lease.state === "lapsed" || (lease.state === "active" && now >= lapsesAt(lease));

const readChange = (changeId: string): NextAction => ({
  kind: "read",
  title: "Read the change for its current lease and state",
  operationId: "Changes_getChange",
  args: { changeId },
});

const adoptChange = (changeId: string): NextAction => ({
  kind: "call",
  title: "Adopt the change: adoption issues a new lease and fences the lapsed one",
  args: { changeId },
});

/**
 * The lease check every mutating call on a change makes: the call must carry
 * the change's current lease, and that lease must not have lapsed. "No lease"
 * is never permission, and a refusal always says what to do next.
 */
export const checkLease = (
  change: Change,
  leaseId: LeaseId,
  now: Instant,
): Result.Result<void, LeaseStale> => {
  if (
    leaseId !== change.lease.id ||
    (change.lease.state !== "active" && change.lease.state !== "lapsed")
  ) {
    return Result.fail(
      new LeaseStale({
        changeId: change.id,
        leaseId,
        reason: "stale",
        nextActions: [readChange(change.id)],
      }),
    );
  }
  if (isLapsed(change.lease, now)) {
    return Result.fail(
      new LeaseStale({
        changeId: change.id,
        leaseId,
        reason: "lapsed",
        nextActions: [adoptChange(change.id)],
      }),
    );
  }
  return Result.void;
};

/**
 * Renews the lease on an authorised call. A renewal is state, not an event:
 * the Change DO persists `renewedAt`, and replaying the events gives the time
 * the lease was issued, never a later one.
 */
export const renew = (
  change: Change,
  leaseId: LeaseId,
  now: Instant,
): Result.Result<Change, LeaseStale> =>
  Result.map(checkLease(change, leaseId, now), () => ({
    ...change,
    lease: { ...change.lease, renewedAt: now },
  }));
