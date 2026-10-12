// The usage store's own rules beside the OrgUsage contract: how long a key
// is remembered, and what an amount may be. Over an in-memory store and a
// clock the test moves.
import { describe, expect, it } from "@effect/vitest";
import {
  admitUsage,
  configureUsage,
  pruneUsageKeys,
  recordUsage,
  USAGE_KEY_TTL_MS,
  usageAddress,
  usageOrg,
  usageSettings,
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
        expect(yield* pruneUsageKeys()).toEqual({ forgotten: 0, kept: 1 });
        // Still its first answer, and still counted once.
        expect(yield* admitUsage(ORG, "projects", 4, "k")).toEqual({
          limit: LIMIT,
          remaining: LIMIT - 4,
        });
        yield* recordUsage(ORG, "projects", 1, "young");
        w.clock.advance(1);
        expect(yield* pruneUsageKeys()).toEqual({ forgotten: 1, kept: 1 });
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
        // Three keys are held now; a week on, none is.
        w.clock.advance(USAGE_KEY_TTL_MS);
        expect(yield* pruneUsageKeys()).toEqual({ forgotten: 3, kept: 0 });
      }).pipe(Effect.provide(w.layer));
    },
  );

  it.effect(
    "[orgusage.settings-finite] a limit that is negative or not a finite number is a defect, and the settings stay as they were",
    () => {
      const w = world();
      return Effect.gen(function* () {
        yield* configureUsage(ORG, { overrides: { projects: 3 }, halted: false });
        for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
          const exit = yield* Effect.exit(
            configureUsage(ORG, { overrides: { projects: limit }, halted: true }),
          );
          expect(Exit.isFailure(exit), `a limit of ${limit}`).toBe(true);
        }
        expect(yield* usageSettings(ORG)).toEqual({ overrides: { projects: 3 }, halted: false });
        // Zero is a limit: nothing more of that kind.
        yield* configureUsage(ORG, { overrides: { projects: 0 }, halted: false });
        expect(yield* Effect.flip(admitUsage(ORG, "projects", 1, "none"))).toMatchObject({
          reason: "limit",
          limit: 0,
        });
      }).pipe(Effect.provide(w.layer));
    },
  );

  it("[orgusage.address] an org's usage object is addressed usage:<orgId>, and no other name is one", () => {
    expect(usageAddress(ORG)).toBe(`usage:${ORG}`);
    expect(usageOrg(usageAddress(ORG))).toBe(ORG);
    for (const name of [
      undefined,
      "",
      ORG,
      "usage:",
      "usage:prj_01J9ZZZZZZZZZZZZZZZZZZZZZZ",
      `usagx:${ORG}`,
      `org:${ORG}`,
    ])
      expect(() => usageOrg(name)).toThrow("usage:<orgId>");
  });

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
