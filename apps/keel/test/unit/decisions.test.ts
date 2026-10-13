import { describe, expect, it } from "@effect/vitest";
import type { EventEnvelope } from "@keeltown/core/kernel";
import { Decisions } from "@keeltown/core/ports";
import { makeDecisionsMemory, projectEvents, ruledConflict } from "@keeltown/testing";
import { Effect } from "effect";
import * as fc from "fast-check";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 100, ...(seed === undefined ? {} : { seed: Number(seed) }) });

/** A property of many folds takes a second alone and several in the whole suite under load. */
const PROPERTY_TIMEOUT = 60_000;

/** What the index answers of one ruled conflict, after these arrivals in this order. */
const readAfter = (ruled: ReturnType<typeof ruledConflict>, arrivals: readonly EventEnvelope[]) => {
  const memory = makeDecisionsMemory();
  return Effect.gen(function* () {
    for (const event of arrivals) yield* memory.arrive(event);
    const decisions = yield* Decisions;
    return {
      decision: yield* decisions.get(ruled.decisionId),
      guarded: yield* decisions.ofGuards(ruled.project, [ruled.guardId]),
      listed: (yield* decisions.list({ project: ruled.project })).items,
    };
  }).pipe(Effect.provide(memory.layer));
};

describe("the decision index", () => {
  it.effect(
    "[decisions.index] the ruling's decision and the conflict's events, arriving in any order and any number of times, read as if each came once in order",
    () =>
      Effect.sync(() =>
        fc.assert(
          fc.property(
            fc.constantFrom("premise-holds" as const, "effect-stands" as const),
            fc.nat(),
            fc.array(fc.nat(), { maxLength: 4 }),
            (option, at, again) => {
              const ruled = ruledConflict(projectEvents());
              const decided = ruled.recorded(option);
              const resolved = ruled.resolved(
                option === "premise-holds" ? [ruled.other] : [ruled.holder],
              );
              // The conflict's own events keep the Subject object's order; the decision comes from another object, at any point.
              const conflict = [...ruled.conflict, resolved];
              const inOrder = [...conflict, decided];
              const position = at % (conflict.length + 1);
              const arrivals = [
                ...conflict.slice(0, position),
                decided,
                ...conflict.slice(position),
              ];
              // An outbox may deliver any event again.
              const repeated = again.reduce<EventEnvelope[]>((events, n) => {
                const event = arrivals[n % arrivals.length];
                return event === undefined ? events : [...events, event];
              }, []);
              const expected = Effect.runSync(readAfter(ruled, inOrder));
              const actual = Effect.runSync(readAfter(ruled, [...arrivals, ...repeated]));
              expect(actual).toEqual(expected);
              expect(expected.decision.holds).toHaveLength(1);
              expect(expected.guarded.length).toBe(option === "premise-holds" ? 1 : 0);
            },
          ),
        ),
      ),
    PROPERTY_TIMEOUT,
  );
});
