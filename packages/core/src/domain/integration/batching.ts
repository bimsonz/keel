import { compare, type Proposition } from "../coordination/index.ts";
import type { ChangeId } from "../kernel/index.ts";
import { batchSize } from "./batch.ts";

/** A change waiting in a lane, with what Keel derived it alters. */
export type QueuedChange = {
  readonly id: ChangeId;
  readonly effects: readonly Proposition[];
  readonly risky: boolean;
};

/** How many speculative batches may be in flight ahead of trunk. */
export const MAX_SPECULATION = 4;

const contradict = (a: Proposition, b: Proposition): boolean =>
  compare(a, b).outcome === "contradicts" || compare(b, a).outcome === "contradicts";

/** Two changes that alter one subject's predicate in incompatible directions. */
export const oppositeEffects = (a: QueuedChange, b: QueuedChange): boolean =>
  a.effects.some((x) => b.effects.some((y) => contradict(x, y)));

const suspected = (
  pairs: readonly (readonly [ChangeId, ChangeId])[],
  a: ChangeId,
  b: ChangeId,
): boolean => pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/**
 * Belief-aware batching. Batches hold at most N = batchSize(p) changes, never
 * two with an open suspected conflict or opposite effects on one subject; a
 * risky change runs alone. Changes are placed first-fit in queue order, at
 * most `maxDepth` batches deep; the rest wait. The queue's head always rides
 * in the first batch.
 */
export const planBatches = (
  queue: readonly QueuedChange[],
  failureRate: number,
  openSuspected: readonly (readonly [ChangeId, ChangeId])[],
  maxDepth: number = MAX_SPECULATION,
): readonly (readonly ChangeId[])[] => {
  const n = batchSize(failureRate);
  const batches: QueuedChange[][] = [];
  const alone = new Set<number>();
  for (const change of queue) {
    const fits = (batch: readonly QueuedChange[], i: number): boolean =>
      !change.risky &&
      !alone.has(i) &&
      batch.length < n &&
      batch.every((m) => !suspected(openSuspected, m.id, change.id) && !oppositeEffects(m, change));
    const slot = batches.findIndex(fits);
    if (slot !== -1) batches[slot]?.push(change);
    else if (batches.length < maxDepth) {
      if (change.risky) alone.add(batches.length);
      batches.push([change]);
    }
  }
  return batches.map((b) => b.map((c) => c.id));
};
