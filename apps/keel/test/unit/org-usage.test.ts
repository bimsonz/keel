// The usage store's own rules beside the OrgUsage contract: how long a key
// is remembered, and what an amount may be. Over an in-memory store and a
// clock the test moves.
import { describe, expect, it } from "@effect/vitest";
import {
  admitUsage,
  pruneUsageKeys,
  recordUsage,
  USAGE_KEY_TTL_MS,
} from "@keeltown/core/application/identity";
import { DEFAULT_QUOTAS } from "@keeltown/core/domain/identity";
import { makeId } from "@keeltown/core/kernel";
import { makeEntityStoreMemory, makeManualClock } from "@keeltown/testing";
import { Effect, Exit, Layer } from "effect";

const ORG = makeId("org", "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
const LIMIT = DEFAULT_QUOTAS.projects;

const world = () => {
  const clock = makeManualClock();
  return { clock, layer: Layer.mergeAll(makeEntityStoreMemory().layer, clock.layer) };
};

describe("the usage store", () => {
  it.effect(
    "[orgusage.prune] a key is forgotten seven days after its first answer and not a moment before, whatever was asked since",
    () => {
      const w = world();
      return Effect.gen(function* () {
        expect(yield* admitUsage(ORG, "projects", 4, "k")).toEqual({
          limit: LIMIT,
          remaining: LIMIT - 4,
        });
        w.clock.advance(USAGE_KEY_TTL_MS - 1);
        expect(yield* pruneUsageKeys()).toBe(0);
        // Still its first answer, and still counted once.
        expect(yield* admitUsage(ORG, "projects", 4, "k")).toEqual({
          limit: LIMIT,
          remaining: LIMIT - 4,
        });
        yield* recordUsage(ORG, "projects", 1, "young");
        w.clock.advance(1);
        expect(yield* pruneUsageKeys()).toBe(1);
        // Forgotten, the key is a new one; the record's younger key is kept, so it counts once.
        expect(yield* admitUsage(ORG, "projects", 4, "k")).toEqual({
          limit: LIMIT,
          remaining: LIMIT - 9,
        });
        yield* recordUsage(ORG, "projects", 1, "young");
        expect(yield* admitUsage(ORG, "projects", 0, "left")).toEqual({
          limit: LIMIT,
          remaining: LIMIT - 9,
        });
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[orgusage.record-finite] an amount that is not a number is a defect, and counts nothing",
    () => {
      const w = world();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(recordUsage(ORG, "projects", Number.NaN, "nan"));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* admitUsage(ORG, "projects", LIMIT, "all")).toEqual({
          limit: LIMIT,
          remaining: 0,
        });
      }).pipe(Effect.provide(w.layer));
    },
  );
});
