import type { EventEnvelope, ProjectId } from "@keeltown/core/kernel";
import { EventFeed, type EventFeedEntry } from "@keeltown/core/ports";
import { Duration, Clock as EffectClock, Effect, Layer } from "effect";

/** Positions sort as strings: twelve digits, as the Projector's. */
const position = (n: number) => String(n).padStart(12, "0");

/**
 * The Projector's feed as an array: `append` is an arrival. A waiting read
 * answers on the next arrival it reads, or with an empty page at its
 * deadline. A read by project filters the array: the plain statement of what
 * the Projector's index answers.
 */
export function makeEventFeedMemory() {
  const entries: EventFeedEntry[] = [];
  let waiting = new Set<() => void>();
  const page = (after: number, limit: number, project?: ProjectId) => {
    const max = Math.min(Math.max(limit, 1), 500);
    if (project === undefined) {
      const events = entries.slice(after, after + max);
      return { events, cursor: position(after + events.length) };
    }
    const mine = entries.flatMap((entry, index) =>
      index >= after && entry.project === project ? [{ entry, at: index + 1 }] : [],
    );
    const cut = mine[max - 1];
    return {
      events: mine.slice(0, max).map((each) => each.entry),
      // Cut by the limit, the last one returned; otherwise the head, past every other project's events.
      cursor: position(
        mine.length > max && cut !== undefined ? cut.at : Math.max(entries.length, after),
      ),
    };
  };
  const nextArrival = (millis: number): Effect.Effect<void> =>
    Effect.callback<void>((resume) => {
      const wake = () => resume(Effect.void);
      waiting.add(wake);
      return Effect.sync(() => waiting.delete(wake));
    }).pipe(Effect.timeoutOption(Duration.millis(millis)), Effect.asVoid);
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
        read: ({ cursor, limit = 100, waitSeconds, project }) =>
          Effect.gen(function* () {
            // `end` is the head as this read finds it: resolved once, before the read first looks.
            const after =
              cursor === undefined ? 0 : cursor === "end" ? entries.length : Number(cursor);
            const deadline = (yield* EffectClock.currentTimeMillis) + waitSeconds * 1000;
            // An arrival the read does not hold (another project's) leaves it waiting for the next.
            while (page(after, limit, project).events.length === 0) {
              const left = deadline - (yield* EffectClock.currentTimeMillis);
              if (left <= 0) break;
              yield* nextArrival(left);
            }
            return page(after, limit, project);
          }),
      }),
    ),
  };
}
