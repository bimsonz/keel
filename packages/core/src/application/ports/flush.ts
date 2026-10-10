import { Effect, Result } from "effect";
import { Instant } from "../../domain/kernel/index.ts";
import { Clock } from "./clock.ts";
import { EntityStore } from "./entity-store.ts";
import {
  type Backlog,
  EventOutbox,
  type FanOut,
  redeliveryDelay,
  STUCK_AFTER_ATTEMPTS,
  type Subscriber,
} from "./event-outbox.ts";

/** At most this many events go to one subscriber per flush; the rest follow at once. */
export const FLUSH_BATCH = 100;

export interface FlushReport {
  readonly delivered: number;
  readonly failed: readonly Subscriber[];
  /** When the next delivery is owed, if any is. The caller arms a deadline for it. */
  readonly nextAttemptAt?: Instant;
  /** Subscribers that have refused `STUCK_AFTER_ATTEMPTS` times. Still retried. */
  readonly stuck: readonly Backlog[];
}

/**
 * Hands every due delivery to its subscriber, oldest first, one batch per
 * subscriber. A delivery is acknowledged only after its subscriber took it; a
 * failure leaves it owed and pushes its next attempt back (1 s, doubling, to
 * 60 s). A stalled subscriber holds only its own deliveries. Every flush that
 * delivered something nudges the Projector.
 */
export const flushOutbox = (
  fanOut: FanOut,
): Effect.Effect<FlushReport, never, Clock | EntityStore | EventOutbox> =>
  Effect.gen(function* () {
    const now = yield* (yield* Clock).now;
    const store = yield* EntityStore;
    const outbox = yield* EventOutbox;
    const outcomes = yield* Effect.forEach(
      outbox.due(now, FLUSH_BATCH),
      (batch) =>
        Effect.map(Effect.result(fanOut.deliver(batch.subscriber, batch.events)), (outcome) => ({
          batch,
          outcome,
        })),
      { concurrency: 8 },
    );
    let delivered = 0;
    const failed: Subscriber[] = [];
    for (const { batch, outcome } of outcomes) {
      const eventIds = batch.events.map((event) => event.eventId);
      if (Result.isSuccess(outcome)) {
        store.transaction(() => outbox.acknowledge(batch.subscriber, eventIds));
        delivered += eventIds.length;
      } else {
        const attempts = batch.attempts + 1;
        store.transaction(() =>
          outbox.defer(
            batch.subscriber,
            eventIds,
            attempts,
            Instant(now + redeliveryDelay(attempts)),
          ),
        );
        failed.push(batch.subscriber);
      }
    }
    if (delivered > 0) yield* fanOut.nudge;
    const backlog = outbox.backlog();
    const stuck = backlog.filter((entry) => entry.attempts >= STUCK_AFTER_ATTEMPTS);
    if (backlog.length === 0) return { delivered, failed, stuck };
    return {
      delivered,
      failed,
      stuck,
      nextAttemptAt: Instant(Math.min(...backlog.map((entry) => entry.nextAttemptAt))),
    };
  });
