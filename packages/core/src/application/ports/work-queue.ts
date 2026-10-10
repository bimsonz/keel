import { Context, type Effect } from "effect";

/** A unit of background work. Delivery is at least once, so every job is idempotent by `dedupeKey`. */
export interface Job {
  readonly kind: string;
  readonly dedupeKey: string;
  readonly payload: unknown;
  readonly delaySeconds?: number;
}

export class WorkQueue extends Context.Service<WorkQueue, {
  readonly enqueue: (jobs: readonly Job[]) => Effect.Effect<void>;
}>()("keel/WorkQueue") {}
