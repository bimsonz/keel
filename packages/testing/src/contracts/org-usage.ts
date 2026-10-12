import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_QUOTAS, type QuotaKind } from "@keeltown/core/domain/identity";
import { type Instant, OrgId } from "@keeltown/core/kernel";
import { OrgUsage } from "@keeltown/core/ports";
import { Effect, Exit, type Layer, Schema } from "effect";

/**
 * What the `OrgUsage` suite needs beside the port: an org the adapter is
 * ready to count for, and the adapter's own clock, which the suite moves
 * across a UTC midnight.
 */
export interface OrgUsageHarness {
  readonly layer: Layer.Layer<OrgUsage>;
  readonly org: () => Effect.Effect<OrgId>;
  readonly now: Effect.Effect<Instant>;
  readonly advance: (ms: number) => Effect.Effect<void>;
}

const DAY_MS = 86_400_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
/** A fresh org id, for a harness whose adapter needs no preparing. */
export const freshOrg = (): OrgId => Schema.decodeUnknownSync(OrgId)(`org_${ulid()}`);

const key = () => `key-${crypto.randomUUID()}`;
const admit = (org: OrgId, kind: QuotaKind, amount: number, k = key()) =>
  Effect.flatMap(OrgUsage, (usage) => usage.admit(org, kind, amount, k));
const record = (org: OrgId, kind: QuotaKind, amount: number, k = key()) =>
  Effect.flatMap(OrgUsage, (usage) => usage.record(org, kind, amount, k));

/** The limit of `projects`, small enough to count to. */
const LIMIT = DEFAULT_QUOTAS.projects;
/** Amounts admitted at once for one org: each list asks for more than the limit, or exactly it. */
const RACES: readonly (readonly number[])[] = [
  [4, 4, 4],
  [LIMIT, 1],
  [1, 2, 3, 4],
  [3, 3, 3, 3, 3],
  [2, 2, 2, 2, 2, 2],
  [4, 3, 2, 1, 4, 3, 2, 1],
];

export function describeOrgUsageContract(adapter: string, make: () => OrgUsageHarness) {
  describe(`OrgUsage contract: ${adapter}`, () => {
    it.live(
      "[orgusage.contract.admit-counts] each admitted amount is counted: the one that reaches the limit exactly is admitted, and one more is refused",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const org = yield* harness.org();
          expect(yield* admit(org, "projects", 4)).toEqual({ limit: LIMIT, remaining: LIMIT - 4 });
          expect(yield* admit(org, "projects", LIMIT - 4)).toEqual({ limit: LIMIT, remaining: 0 });
          const refused = yield* Effect.flip(admit(org, "projects", 1));
          expect(refused).toMatchObject({
            _tag: "QuotaExceeded",
            kind: "projects",
            reason: "limit",
            limit: LIMIT,
            used: LIMIT,
            requested: 1,
          });
          expect(refused.nextActions.length).toBeGreaterThan(0);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[orgusage.contract.refusal-counts-nothing] a refused amount is not counted, so what still fits is admitted after it",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const org = yield* harness.org();
          yield* admit(org, "projects", LIMIT - 2);
          expect(Exit.isFailure(yield* Effect.exit(admit(org, "projects", 5)))).toBe(true);
          expect(yield* admit(org, "projects", 2)).toEqual({ limit: LIMIT, remaining: 0 });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[orgusage.contract.record-never-refuses] a record past the limit is counted all the same, and the next admission sees it",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const org = yield* harness.org();
          yield* record(org, "projects", LIMIT + 3);
          expect(yield* Effect.flip(admit(org, "projects", 1))).toMatchObject({
            reason: "limit",
            used: LIMIT + 3,
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[orgusage.contract.record-gives-back] a negative record frees what was counted, and never leaves credit below zero",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const org = yield* harness.org();
          yield* admit(org, "projects", LIMIT);
          yield* record(org, "projects", -3);
          expect(yield* admit(org, "projects", 3)).toEqual({ limit: LIMIT, remaining: 0 });
          const other = yield* harness.org();
          yield* record(other, "projects", -100);
          expect(yield* admit(other, "projects", LIMIT)).toEqual({ limit: LIMIT, remaining: 0 });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[orgusage.contract.idempotent] a key answers as it first did and counts once: an admission, a refusal and a record alike",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const org = yield* harness.org();
          const [first, extra, over, given] = [key(), key(), key(), key()];
          for (const _ of [1, 2])
            expect(yield* admit(org, "projects", 4, first)).toEqual({
              limit: LIMIT,
              remaining: LIMIT - 4,
            });
          for (const _ of [1, 2]) yield* record(org, "projects", 2, extra);
          // Counted once each: 4 admitted and 2 recorded.
          expect(yield* Effect.flip(admit(org, "projects", LIMIT, over))).toMatchObject({
            reason: "limit",
            used: 6,
          });
          for (const _ of [1, 2]) yield* record(org, "projects", -3, given);
          // The refusal is its key's answer for good, even once there is room again.
          expect(yield* Effect.flip(admit(org, "projects", LIMIT, over))).toMatchObject({
            reason: "limit",
            used: 6,
          });
          // Given back once: 3 are still counted.
          expect(yield* admit(org, "projects", LIMIT - 3)).toEqual({ limit: LIMIT, remaining: 0 });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("[orgusage.contract.apart] one org's count, kind and keys are no other's", () => {
      const harness = make();
      return Effect.gen(function* () {
        const [one, two] = [yield* harness.org(), yield* harness.org()];
        const shared = key();
        yield* admit(one, "projects", LIMIT, shared);
        expect(yield* admit(two, "projects", 1, shared)).toEqual({
          limit: LIMIT,
          remaining: LIMIT - 1,
        });
        // The same key under another kind is another key, counted on that kind alone.
        expect(yield* admit(one, "agents", 1, shared)).toEqual({
          limit: DEFAULT_QUOTAS.agents,
          remaining: DEFAULT_QUOTAS.agents - 1,
        });
      }).pipe(Effect.provide(harness.layer));
    });

    it.live(
      "[orgusage.contract.daily-reset] container-minutes are counted per UTC day and a refusal says when they reset; repo bytes never reset",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const org = yield* harness.org();
          const minutes = DEFAULT_QUOTAS["container-minutes"];
          const bytes = DEFAULT_QUOTAS["repo-bytes"];
          yield* admit(org, "container-minutes", minutes);
          yield* admit(org, "repo-bytes", bytes);
          const midnight = (Math.floor((yield* harness.now) / DAY_MS) + 1) * DAY_MS;
          expect(yield* Effect.flip(admit(org, "container-minutes", 1))).toMatchObject({
            reason: "limit",
            retryAt: midnight,
          });
          yield* harness.advance(midnight - (yield* harness.now));
          expect(yield* admit(org, "container-minutes", 1)).toEqual({
            limit: minutes,
            remaining: minutes - 1,
          });
          const stillFull = yield* Effect.flip(admit(org, "repo-bytes", 1));
          expect(stillFull).toMatchObject({ reason: "limit", used: bytes });
          expect(stillFull.retryAt).toBeUndefined();
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[orgusage.contract.serialised] admissions racing for one org never pass its limit between them, and each is counted",
      () => {
        const harness = make();
        return Effect.forEach(RACES, (amounts) =>
          Effect.gen(function* () {
            const org = yield* harness.org();
            const exits = yield* Effect.forEach(
              amounts,
              (amount) => Effect.exit(admit(org, "projects", amount)),
              { concurrency: "unbounded" },
            );
            const admitted = amounts
              .filter((_, i) => {
                const exit = exits[i];
                return exit !== undefined && Exit.isSuccess(exit);
              })
              .reduce((sum, amount) => sum + amount, 0);
            expect(admitted, `racing ${amounts.join(",")}`).toBeLessThanOrEqual(LIMIT);
            // What is left is the limit less everything admitted: nothing lost, nothing counted twice.
            expect(yield* admit(org, "projects", 0)).toEqual({
              limit: LIMIT,
              remaining: LIMIT - admitted,
            });
          }),
        ).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
