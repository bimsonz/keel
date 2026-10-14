// A Workflow's warm pool, apart from its Durable Object so its rules are
// tested without one: which instance a claim gets, when one is too near its
// end to hand out, how many to start, and when the pool must next act. A warm
// instance is created waiting for its claim's event, for at most
// POOL_WAIT_MS; a claim hands it the input an event would have started a cold
// one with. The claim is kept before it is answered (the object keeps one row
// per claim), so a redelivery of the same event gets the same answer, warm or
// cold, and never a second run.

/** How long a warm instance waits for its claim before it retires, as its `waitForEvent` timeout says. */
export const POOL_WAIT_MS = 24 * 60 * 60_000;
export const POOL_WAIT = "24 hours";

/** A warm instance is never handed out this near its end: the claim's event must reach it before it retires. */
export const RETIRE_MARGIN_MS = 10 * 60_000;

/** The pool starts instances up to its target whenever a claim leaves fewer than POOL_LOW_WATER to hand out. */
export const POOL_LOW_WATER = 2;

/**
 * How many warm instances a pool keeps, from its deployment's setting: a
 * whole number, and 0 (none kept, every claim answered cold) for anything
 * else or nothing.
 */
export function warmTarget(setting: string | undefined): number {
  const target = Number(setting);
  return Number.isSafeInteger(target) && target > 0 ? target : 0;
}

/**
 * How long a claim's answer is kept for a redelivery of its event. The outbox
 * sets no horizon of its own: it retries an event it could not deliver at
 * most a minute apart until it is taken (`redeliveryDelay`, `flushOutbox`).
 * So the pool's own bound decides: an answered instance was created before
 * its claim and waits POOL_WAIT_MS at most, so once that has passed it has
 * retired and its answer can reach nothing. A redelivery that comes later is
 * claimed again: a second run of the same submission ends at its first step,
 * refused by the change, having written nothing.
 */
export const CLAIM_MEMORY_MS = POOL_WAIT_MS;

import { COLD } from "../../../rpc/workflow-pool.ts";

export { COLD, POOL_CLAIM_EVENT } from "../../../rpc/workflow-pool.ts";

/** A warm instance, by its id, and when its wait ends. */
export interface WarmInstance {
  readonly id: string;
  readonly retiresAt: number;
}

/** One event's claim as it is kept: what it was answered (an instance's id, or COLD), and when it is forgotten. */
export interface Claim {
  readonly eventId: string;
  readonly answer: string;
  readonly forgetAt: number;
}

export interface PoolState {
  /** Oldest first, so the one nearest its end is handed out first. */
  readonly warm: readonly WarmInstance[];
}

export const EMPTY_POOL: PoolState = { warm: [] };

const usable = (instance: WarmInstance, now: number) => instance.retiresAt - RETIRE_MARGIN_MS > now;

/** The pool as it can be handed out at `now`: instances near their end dropped (they retire on their own). */
export const current = (state: PoolState, now: number): PoolState => ({
  warm: state.warm.filter((instance) => usable(instance, now)),
});

/**
 * One event's claim: `prior`, the answer it was given before while that is
 * still kept; else the warm instance nearest its end that can still take it;
 * else COLD. A new answer comes with the claim to keep, warm or cold, and a
 * warm instance is handed out once.
 */
export function claim(
  state: PoolState,
  eventId: string,
  prior: string | undefined,
  now: number,
): { readonly answer: string; readonly state: PoolState; readonly kept?: Claim } {
  const pool = current(state, now);
  if (prior !== undefined) return { answer: prior, state: pool };
  const [first, ...rest] = pool.warm;
  const answer = first?.id ?? COLD;
  return {
    answer,
    state: { warm: first === undefined ? pool.warm : rest },
    kept: { eventId, answer, forgetAt: now + CLAIM_MEMORY_MS },
  };
}

/** The pool with instances just created at `now`, each waiting POOL_WAIT_MS. */
export function added(state: PoolState, ids: readonly string[], now: number): PoolState {
  const fresh = ids.map((id) => ({ id, retiresAt: now + POOL_WAIT_MS }));
  return {
    warm: [...state.warm, ...fresh].toSorted((a, b) => a.retiresAt - b.retiresAt),
  };
}

/**
 * How many instances to start: after a claim, up to `target` once fewer
 * than POOL_LOW_WATER can be handed out; at the pool's deadline, up to
 * `target` whatever is left, replacing the ones about to retire.
 */
export function toStart(
  state: PoolState,
  now: number,
  trigger: "claim" | "deadline",
  target: number,
): number {
  const left = current(state, now).warm.length;
  if (trigger === "claim" && left >= POOL_LOW_WATER) return 0;
  return Math.max(0, target - left);
}

/** When the pool must next act: the moment its first instance stops being handed out. None for an empty pool. */
export function nextDeadline(state: PoolState): number | undefined {
  const first = state.warm[0];
  return first === undefined ? undefined : first.retiresAt - RETIRE_MARGIN_MS;
}
