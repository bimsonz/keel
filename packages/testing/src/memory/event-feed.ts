import type { EventEnvelope } from "@keeltown/core/kernel";
import { EventFeed, type EventFeedEntry } from "@keeltown/core/ports";
import { Duration, Effect, Layer } from "effect";

/** Positions sort as strings: twelve digits, as the Projector's. */
const position = (n: number) => String(n).padStart(12, "0");

/**
 * The Projector's feed as an array: `append` is an arrival. A waiting read
 * answers on the next arrival, or with an empty page at its deadline.
 */
export function makeEventFeedMemory() {
  const entries: EventFeedEntry[] = [];
  let waiting = new Set<() => void>();
  const page = (after: number, limit: number) => {
    const events = entries.slice(after, after + Math.min(Math.max(limit, 1), 500));
    return { events, cursor: position(after + events.length) };
  };
  const nextArrival = (seconds: number): Effect.Effect<void> =>
    Effect.callback<void>((resume) => {
      const wake = () => resume(Effect.void);
      waiting.add(wake);
      return Effect.sync(() => waiting.delete(wake));
    }).pipe(Effect.timeoutOption(Duration.seconds(seconds)), Effect.asVoid);
  return {
    entries,
    append: (event: EventEnvelope, label?: string): void => {
      entries.push(label === undefined ? event : { ...event, label });
      const woken = waiting;
      waiting = new Set();
      for (const wake of woken) wake();
    },
    layer: Layer.succeed(
      EventFeed,
      EventFeed.of({
        read: ({ cursor, limit = 100, waitSeconds }) =>
          Effect.gen(function* () {
            const after = cursor === undefined ? 0 : Number(cursor);
            if (page(after, limit).events.length === 0 && waitSeconds > 0) {
              yield* nextArrival(waitSeconds);
            }
            return page(after, limit);
          }),
      }),
    ),
  };
}
