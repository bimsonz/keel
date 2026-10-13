import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_QUOTAS, type QuotaKind } from "@keeltown/core/domain/identity";
import { type Instant, NamespaceId } from "@keeltown/core/kernel";
import { NamespaceUsage, type UsageSettings } from "@keeltown/core/ports";
import { Effect, Exit, type Layer, Schema } from "effect";

/**
 * What the `NamespaceUsage` suite needs beside the port: a namespace the adapter is
 * ready to count for, and the adapter's own clock, which the suite moves
 * across a UTC midnight.
 */
export interface NamespaceUsageHarness {
  readonly layer: Layer.Layer<NamespaceUsage>;
  readonly namespace: () => Effect.Effect<NamespaceId>;
  readonly now: Effect.Effect<Instant>;
  readonly advance: (ms: number) => Effect.Effect<void>;
}

const DAY_MS = 86_400_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
/** The kinds of account a namespace is: a person's, an agent's, an org's. */
const KINDS = ["usr", "agt", "org"] as const;
let minted = 0;
/** A fresh namespace id, of each kind in turn, for a harness whose adapter needs no preparing. */
export const freshNamespace = (): NamespaceId =>
  Schema.decodeUnknownSync(NamespaceId)(`${KINDS[minted++ % KINDS.length]}_${ulid()}`);

const key = () => `key-${crypto.randomUUID()}`;
const admit = (namespace: NamespaceId, kind: QuotaKind, amount: number, k = key()) =>
  Effect.flatMap(NamespaceUsage, (usage) => usage.admit(namespace, kind, amount, k));
const record = (namespace: NamespaceId, kind: QuotaKind, amount: number, k = key()) =>
  Effect.flatMap(NamespaceUsage, (usage) => usage.record(namespace, kind, amount, k));

const configure = (namespace: NamespaceId, settings: UsageSettings) =>
  Effect.flatMap(NamespaceUsage, (usage) => usage.configure(namespace, settings));
const settingsOf = (namespace: NamespaceId) =>
  Effect.flatMap(NamespaceUsage, (usage) => usage.settings(namespace));

/** The kinds a halt stops: what verification spends. */
const SPEND: readonly QuotaKind[] = ["container-minutes", "model-calls", "concurrent-containers"];

/** The limit of `projects`, small enough to count to. */
const LIMIT = DEFAULT_QUOTAS.projects;
/** Amounts admitted at once for one namespace: each list asks for more than the limit, or exactly it. */
const RACES: readonly (readonly number[])[] = [
  [4, 4, 4],
  [LIMIT, 1],
  [1, 2, 3, 4],
  [3, 3, 3, 3, 3],
  [2, 2, 2, 2, 2, 2],
  [4, 3, 2, 1, 4, 3, 2, 1],
];

export function describeNamespaceUsageContract(adapter: string, make: () => NamespaceUsageHarness) {
  describe(`NamespaceUsage contract: ${adapter}`, () => {
    it.live(
      "[usage.contract.admit-counts] each admitted amount is counted: the one that reaches the limit exactly is admitted, and one more is refused",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const namespace = yield* harness.namespace();
          expect(yield* admit(namespace, "projects", 4)).toEqual({
            limit: LIMIT,
            remaining: LIMIT - 4,
          });
          expect(yield* admit(namespace, "projects", LIMIT - 4)).toEqual({
            limit: LIMIT,
            remaining: 0,
          });
          const refused = yield* Effect.flip(admit(namespace, "projects", 1));
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
      "[usage.contract.refusal-counts-nothing] a refused amount is not counted, so what still fits is admitted after it",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const namespace = yield* harness.namespace();
          yield* admit(namespace, "projects", LIMIT - 2);
          expect(Exit.isFailure(yield* Effect.exit(admit(namespace, "projects", 5)))).toBe(true);
          expect(yield* admit(namespace, "projects", 2)).toEqual({ limit: LIMIT, remaining: 0 });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[usage.contract.record-never-refuses] a record past the limit is counted all the same, and the next admission sees it",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const namespace = yield* harness.namespace();
          yield* record(namespace, "projects", LIMIT + 3);
          expect(yield* Effect.flip(admit(namespace, "projects", 1))).toMatchObject({
            reason: "limit",
            used: LIMIT + 3,
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[usage.contract.record-gives-back] a negative record frees what was counted, and never leaves credit below zero",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const namespace = yield* harness.namespace();
          yield* admit(namespace, "projects", LIMIT);
          yield* record(namespace, "projects", -3);
          expect(yield* admit(namespace, "projects", 3)).toEqual({ limit: LIMIT, remaining: 0 });
          const other = yield* harness.namespace();
          yield* record(other, "projects", -100);
          expect(yield* admit(other, "projects", LIMIT)).toEqual({ limit: LIMIT, remaining: 0 });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[usage.contract.idempotent] a key answers as it first did and counts once: an admission, a refusal and a record alike",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const namespace = yield* harness.namespace();
          const [first, extra, over, given] = [key(), key(), key(), key()];
          for (const _ of [1, 2])
            expect(yield* admit(namespace, "projects", 4, first)).toEqual({
              limit: LIMIT,
              remaining: LIMIT - 4,
            });
          for (const _ of [1, 2]) yield* record(namespace, "projects", 2, extra);
          // Counted once each: 4 admitted and 2 recorded.
          expect(yield* Effect.flip(admit(namespace, "projects", LIMIT, over))).toMatchObject({
            reason: "limit",
            used: 6,
          });
          for (const _ of [1, 2]) yield* record(namespace, "projects", -3, given);
          // The refusal is its key's answer for good, even once there is room again.
          expect(yield* Effect.flip(admit(namespace, "projects", LIMIT, over))).toMatchObject({
            reason: "limit",
            used: 6,
          });
          // Given back once: 3 are still counted.
          expect(yield* admit(namespace, "projects", LIMIT - 3)).toEqual({
            limit: LIMIT,
            remaining: 0,
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live("[usage.contract.apart] one namespace's count, kind and keys are no other's", () => {
      const harness = make();
      return Effect.gen(function* () {
        const [one, two] = [yield* harness.namespace(), yield* harness.namespace()];
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
      "[usage.contract.daily-reset] container-minutes are counted per UTC day and a refusal says when they reset; repo bytes never reset",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const namespace = yield* harness.namespace();
          const minutes = DEFAULT_QUOTAS["container-minutes"];
          const bytes = DEFAULT_QUOTAS["repo-bytes"];
          yield* admit(namespace, "container-minutes", minutes);
          yield* admit(namespace, "repo-bytes", bytes);
          const midnight = (Math.floor((yield* harness.now) / DAY_MS) + 1) * DAY_MS;
          expect(yield* Effect.flip(admit(namespace, "container-minutes", 1))).toMatchObject({
            reason: "limit",
            retryAt: midnight,
          });
          yield* harness.advance(midnight - (yield* harness.now));
          expect(yield* admit(namespace, "container-minutes", 1)).toEqual({
            limit: minutes,
            remaining: minutes - 1,
          });
          const stillFull = yield* Effect.flip(admit(namespace, "repo-bytes", 1));
          expect(stillFull).toMatchObject({ reason: "limit", used: bytes });
          expect(stillFull.retryAt).toBeUndefined();
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[usage.contract.settings] a namespace's settings start empty, read back as configured, are replaced whole, and are no other namespace's",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const [one, two] = [yield* harness.namespace(), yield* harness.namespace()];
          expect(yield* settingsOf(one)).toEqual({ overrides: {}, halted: false });
          yield* configure(one, { overrides: { projects: 3, "repo-bytes": 5 }, halted: true });
          expect(yield* settingsOf(one)).toEqual({
            overrides: { projects: 3, "repo-bytes": 5 },
            halted: true,
          });
          expect(yield* settingsOf(two)).toEqual({ overrides: {}, halted: false });
          yield* configure(one, { overrides: { agents: 1 }, halted: false });
          expect(yield* settingsOf(one)).toEqual({ overrides: { agents: 1 }, halted: false });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[usage.contract.override] a namespace's own limit takes precedence over the instance's, below it and above it, for that namespace and that kind alone",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const [small, large, plain] = [
            yield* harness.namespace(),
            yield* harness.namespace(),
            yield* harness.namespace(),
          ];
          yield* configure(small, { overrides: { projects: 3 }, halted: false });
          expect(yield* admit(small, "projects", 3)).toEqual({ limit: 3, remaining: 0 });
          expect(yield* Effect.flip(admit(small, "projects", 1))).toMatchObject({
            reason: "limit",
            limit: 3,
            used: 3,
          });
          expect(yield* admit(small, "agents", 1)).toEqual({
            limit: DEFAULT_QUOTAS.agents,
            remaining: DEFAULT_QUOTAS.agents - 1,
          });
          yield* configure(large, { overrides: { projects: LIMIT + 5 }, halted: false });
          expect(yield* admit(large, "projects", LIMIT + 5)).toEqual({
            limit: LIMIT + 5,
            remaining: 0,
          });
          expect(yield* admit(plain, "projects", LIMIT)).toEqual({ limit: LIMIT, remaining: 0 });
          expect(yield* Effect.flip(admit(plain, "projects", 1))).toMatchObject({ limit: LIMIT });
          // A raised limit admits what the old one refused, on what was already counted.
          yield* configure(small, { overrides: { projects: 4 }, halted: false });
          expect(yield* admit(small, "projects", 1)).toEqual({ limit: 4, remaining: 0 });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[usage.contract.halted] a halted namespace's spend kinds are refused and count nothing, its other kinds are admitted, and lifting the halt admits again",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const [namespace, other] = [yield* harness.namespace(), yield* harness.namespace()];
          yield* configure(namespace, { overrides: {}, halted: true });
          for (const kind of SPEND)
            expect(yield* Effect.flip(admit(namespace, kind, 1))).toMatchObject({
              _tag: "QuotaExceeded",
              kind,
              reason: "halted",
              used: 0,
            });
          expect(yield* admit(namespace, "repo-bytes", 1)).toEqual({
            limit: DEFAULT_QUOTAS["repo-bytes"],
            remaining: DEFAULT_QUOTAS["repo-bytes"] - 1,
          });
          expect(yield* admit(namespace, "projects", 1)).toEqual({
            limit: LIMIT,
            remaining: LIMIT - 1,
          });
          expect(yield* admit(other, "model-calls", 1)).toEqual({
            limit: DEFAULT_QUOTAS["model-calls"],
            remaining: DEFAULT_QUOTAS["model-calls"] - 1,
          });
          yield* configure(namespace, { overrides: {}, halted: false });
          // Nothing was counted while it was halted.
          for (const kind of SPEND)
            expect(yield* admit(namespace, kind, 1)).toEqual({
              limit: DEFAULT_QUOTAS[kind],
              remaining: DEFAULT_QUOTAS[kind] - 1,
            });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.live(
      "[usage.contract.serialised] admissions racing for one namespace never pass its limit between them, and each is counted",
      () => {
        const harness = make();
        return Effect.forEach(RACES, (amounts) =>
          Effect.gen(function* () {
            const namespace = yield* harness.namespace();
            const exits = yield* Effect.forEach(
              amounts,
              (amount) => Effect.exit(admit(namespace, "projects", amount)),
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
            expect(yield* admit(namespace, "projects", 0)).toEqual({
              limit: LIMIT,
              remaining: LIMIT - admitted,
            });
          }),
        ).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
