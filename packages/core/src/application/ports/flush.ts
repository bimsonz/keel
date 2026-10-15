import { Effect, Result } from "effect";
import { Instant } from "../../domain/kernel/index.ts";
import { Clock } from "./clock.ts";
import { EntityStore } from "./entity-store.ts";
import {
  type Backlog,
  DeliveryFailed,
  EventOutbox,
  type FanOut,
  redeliveryDelay,
  STUCK_AFTER_ATTEMPTS,
  type Subscriber,
} from "./event-outbox.ts";

/** At most this many events go to one subscriber per flush; the rest follow at once. */
export const FLUSH_BATCH = 100;

/** How long one delivery may go unanswered before it counts as failed and waits for its retry. */
export const DELIVERY_BOUND_MS = 30_000;

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
 * subscriber. A delivery is acknowledged as soon as its subscriber took it; a
 * failure, or no answer within DELIVERY_BOUND_MS, leaves it owed and pushes its
 * next attempt back (1 s, doubling, to 60 s). A stalled subscriber, failing or
 * silent, holds only its own deliveries. Every flush that delivered something
 * nudges the Projector. `boundMs` is DELIVERY_BOUND_MS but where a test sets its own.
 */
export const flushOutbox = (
  fanOut: FanOut,
  boundMs: number = DELIVERY_BOUND_MS,
): Effect.Effect<FlushReport, never, Clock | EntityStore | EventOutbox> =>
  Effect.gen(function* () {
    const now = yield* (yield* Clock).now;
    const store = yield* EntityStore;
    const outbox = yield* EventOutbox;
    const settled = yield* Effect.forEach(
      outbox.due(now, FLUSH_BATCH),
      (batch) =>
        fanOut.deliver(batch.subscriber, batch.events).pipe(
          Effect.timeoutOrElse({
            duration: boundMs,
            orElse: () =>
              Effect.fail(
                new DeliveryFailed({
                  subscriber: batch.subscriber,
                  reason: `no answer within ${boundMs} ms`,
                }),
              ),
          }),
          Effect.result,
          // Each delivery's outcome is written as it returns, so one still in flight holds no other's.
          Effect.map((outcome) => {
            const eventIds = batch.events.map((event) => event.eventId);
            if (Result.isSuccess(outcome)) {
              store.transaction(() => outbox.acknowledge(batch.subscriber, eventIds));
              return { delivered: eventIds.length };
            }
            const attempts = batch.attempts + 1;
            store.transaction(() =>
              outbox.defer(
                batch.subscriber,
                eventIds,
                attempts,
                Instant(now + redeliveryDelay(attempts)),
              ),
            );
            return { failed: batch.subscriber };
          }),
        ),
      { concurrency: 8 },
    );
    let delivered = 0;
    const failed: Subscriber[] = [];
    for (const outcome of settled) {
      if ("failed" in outcome) failed.push(outcome.failed);
      else delivered += outcome.delivered;
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
