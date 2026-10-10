import { Instant, makeId } from "@keeltown/core/kernel";
import { Clock, Ids } from "@keeltown/core/ports";
import { Clock as EffectClock, Effect, Layer } from "effect";
import { monotonicFactory } from "ulid";

/** Time from Effect's Clock: in a Worker that is the platform clock, frozen during CPU work. */
export const ClockLive = Layer.succeed(
  Clock,
  Clock.of({ now: Effect.map(EffectClock.currentTimeMillis, (ms) => Instant(ms)) }),
);

/** ULIDs, monotonic within the isolate, so ids minted in one millisecond still sort in order. */
export const IdsLive = Layer.sync(Ids, () => {
  const next = monotonicFactory();
  return Ids.of({
    next: (prefix) => Effect.map(EffectClock.currentTimeMillis, (ms) => makeId(prefix, next(ms))),
  });
});

/** The adapters that need no binding. */
export const SystemLive = Layer.mergeAll(ClockLive, IdsLive);
