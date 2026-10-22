import { Result } from "effect";
import {
  type Instant,
  type LeaseId,
  type NextAction,
  Instant as instant,
} from "../kernel/index.ts";
import { type Change, isAgentOwned, type Lease, LEASE_TTL_MS } from "./change.ts";
import { LeaseStale } from "./errors.ts";

/**
 * When the lease lapses unless it is renewed first: 15 minutes after its last
 * renewal, or after Keel last handed the change back to its agent.
 */
export const lapsesAt = (lease: Lease): Instant => instant(lease.renewedAt + LEASE_TTL_MS);

/**
 * Whether the lease's deadline has passed at `now`, whoever holds the change:
 * the lease's own time rule. The fold judges an adoption by it, so a log
 * decided under any rule of when a lease lapses still folds.
 */
export const deadlinePassed = (lease: Lease, now: Instant): boolean =>
  lease.state === "lapsed" || (lease.state === "active" && now >= lapsesAt(lease));

/** Whether the change waits on its agent, so that its lease's deadline runs: agent-owned, or parked for adoption. A proposal has no lease to run. */
const waitsOnAgent = (change: Change): boolean =>
  isAgentOwned(change.state) || (change.state === "parked" && change.parkReason === "lease-lapsed");

/**
 * Whether the change's lease has lapsed at `now`. Computed on read, from
 * `renewedAt` and the time passed in: the deadline alarm only makes a lapse
 * visible as an event, so a lease is Lapsed from its deadline on whether or
 * not it has fired. The deadline runs only while the change waits on its
 * agent: while Keel holds the change its lease cannot lapse, and handing it
 * back starts the 15 minutes again. A lapse recorded while Keel held the
 * change, under the rule before this one, does not stand either.
 */
export const isLapsed = (change: Change, now: Instant): boolean =>
  change.lease !== undefined && waitsOnAgent(change) && deadlinePassed(change.lease, now);

/**
 * Whether the change's lease is still its holder's permit: active, or recorded
 * Lapsed while Keel held the change, which does not stand. No one else can
 * hold such a lease, since an adoption issues a new one, and handing the
 * change back restarts it.
 */
export const leaseStands = (change: Change): boolean =>
  change.lease !== undefined &&
  (change.lease.state === "active" || (change.lease.state === "lapsed" && !waitsOnAgent(change)));

const readChange = (changeId: string): NextAction => ({
  kind: "read",
  title: "Read the change for its current lease and state",
  operationId: "change",
  args: { changeId },
});

const adoptChange = (changeId: string): NextAction => ({
  kind: "call",
  title: "Adopt the change: adoption issues a new lease and fences the lapsed one",
  operationId: "adopt",
  args: { changeId },
});

/**
 * The lease check every mutating call on a change makes: the call must carry
 * the change's current lease, and that lease must not have lapsed. "No lease"
 * is never permission, and a refusal always says what to do next: a change no
 * agent holds (a proposal) takes no call under a lease at all.
 */
export const checkLease = (
  change: Change,
  leaseId: LeaseId,
  now: Instant,
): Result.Result<void, LeaseStale> => {
  if (
    change.lease === undefined ||
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
  if (isLapsed(change, now)) {
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
  Result.flatMap(checkLease(change, leaseId, now), () =>
    change.lease === undefined
      ? Result.fail(
          new LeaseStale({
            changeId: change.id,
            leaseId,
            reason: "stale",
            nextActions: [readChange(change.id)],
          }),
        )
      : Result.succeed({ ...change, lease: { ...change.lease, renewedAt: now } }),
  );
