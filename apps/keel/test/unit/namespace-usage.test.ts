// The usage store's own rules beside the NamespaceUsage contract: how long a key
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
  usageNamespace,
  usageSettings,
} from "@keeltown/core/application/identity";
import { DEFAULT_QUOTAS } from "@keeltown/core/domain/identity";
import { makeId } from "@keeltown/core/kernel";
import { InstanceQuotas, type InstanceQuotasConfig } from "@keeltown/core/ports";
import { makeEntityStoreMemory, makeManualClock } from "@keeltown/testing";
import { Effect, Exit, Layer } from "effect";
import { instanceQuotas } from "../../src/composition/quotas.ts";

// A namespace is a person's, an agent's or an org's, by the id of its account.
const PERSON = makeId("usr", "01J9ZZZZZZZZZZZZZZZZZZZZZX");
const AGENT = makeId("agt", "01J9ZZZZZZZZZZZZZZZZZZZZZY");
const ORG = makeId("org", "01J9ZZZZZZZZZZZZZZZZZZZZZZ");
const LIMIT = DEFAULT_QUOTAS.projects;

const world = () => {
  const clock = makeManualClock();
  return { clock, layer: Layer.mergeAll(makeEntityStoreMemory().layer, clock.layer) };
};

describe("the usage store", () => {
  it.effect(
    "[usage.prune] a key is forgotten seven days after its first answer and not a moment before, whatever was asked since",
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
    "[usage.settings-finite] a limit that is negative or not a finite number is a defect, and the settings stay as they were",
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

  it("[usage.address] a namespace's usage object is addressed usage:<namespaceId>, and no other name is one", () => {
    for (const namespace of [PERSON, AGENT, ORG]) {
      expect(usageAddress(namespace)).toBe(`usage:${namespace}`);
      expect(usageNamespace(usageAddress(namespace))).toBe(namespace);
    }
    for (const name of [
      undefined,
      "",
      ORG,
      "usage:",
      "usage:prj_01J9ZZZZZZZZZZZZZZZZZZZZZZ",
      `usagx:${ORG}`,
      `org:${ORG}`,
      `namespace:${ORG}`,
    ])
      expect(() => usageNamespace(name)).toThrow("usage:<namespaceId>");
  });

  it.effect(
    "[usage.record-finite] an amount that is not a number is a defect, and counts nothing",
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

describe("the instance's quota configuration", () => {
  // Limits written out, never taken from the code under test.
  const CONFIG: InstanceQuotasConfig = {
    defaults: { "container-minutes": 300, projects: 4 },
    namespaces: { [ORG]: { "container-minutes": 9000, "concurrent-containers": 40 } },
  };
  const configured = () => {
    const w = world();
    return { ...w, layer: Layer.mergeAll(w.layer, Layer.succeed(InstanceQuotas, CONFIG)) };
  };

  it.effect(
    "[usage.configured] a namespace's own limit comes before the instance's for it, and that before the instance's defaults, kind by kind",
    () =>
      Effect.gen(function* () {
        // The org's configured entry, over the configured default.
        expect(yield* admitUsage(ORG, "container-minutes", 9000, "org-all")).toEqual({
          limit: 9000,
          remaining: 0,
        });
        // A kind the org's entry leaves out: the configured default, then DEFAULT_QUOTAS.
        expect(yield* admitUsage(ORG, "projects", 1, "org-p")).toEqual({ limit: 4, remaining: 3 });
        expect(yield* admitUsage(ORG, "model-calls", 1, "org-m")).toEqual({
          limit: DEFAULT_QUOTAS["model-calls"],
          remaining: DEFAULT_QUOTAS["model-calls"] - 1,
        });
        // A namespace the configuration does not name has its defaults.
        const refused = yield* Effect.exit(admitUsage(PERSON, "container-minutes", 301, "p-over"));
        expect(Exit.isFailure(refused)).toBe(true);
        expect(yield* admitUsage(PERSON, "container-minutes", 300, "p-all")).toEqual({
          limit: 300,
          remaining: 0,
        });
        // The namespace's own setting wins over both, and settings say the limits as they apply.
        yield* configureUsage(AGENT, { overrides: { "container-minutes": 7 }, halted: false });
        expect(yield* admitUsage(AGENT, "container-minutes", 7, "a-all")).toEqual({
          limit: 7,
          remaining: 0,
        });
        expect(yield* usageSettings(ORG)).toEqual({
          overrides: { "container-minutes": 9000, "concurrent-containers": 40, projects: 4 },
          halted: false,
        });
        expect(yield* usageSettings(AGENT)).toEqual({
          overrides: { "container-minutes": 7, projects: 4 },
          halted: false,
        });
      }).pipe(Effect.provide(configured().layer)),
  );

  it("[usage.instance-quotas] KEEL_QUOTAS decodes as the configuration, empty is none, and anything else stops the composition", () => {
    expect(instanceQuotas("{}")).toEqual({});
    expect(instanceQuotas("")).toEqual({});
    expect(instanceQuotas(JSON.stringify(CONFIG))).toEqual(CONFIG);
    for (const bad of [
      "not json",
      "[]",
      JSON.stringify({ defaults: { "container-minutes": -1 } }),
      JSON.stringify({ defaults: { "box-hours": 3 } }),
      JSON.stringify({ namespaces: { keel: { projects: 3 } } }),
    ])
      expect(() => instanceQuotas(bad)).toThrow(/KEEL_QUOTAS/);
  });
});
