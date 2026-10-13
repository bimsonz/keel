/**
 * `ensureDeps` over the in-memory DepsBuilder and the Workflow's two durable
 * steps kept in memory: what a plan's Tier 2 steps are handed, and that a
 * replay asks the port for nothing.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  DepsAnswer,
  DepsNeed,
  type DepsSteps,
  ensureDeps,
} from "@keeltown/core/application/verification";
import type { PlanStep } from "@keeltown/core/domain/verification";
import { ContentHash } from "@keeltown/core/kernel";
import { DepsBuilder, ManifestUnreadable } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import { makeDepsBuilderMemory } from "../src/memory/verification.ts";
import { otherNamespace, sampleNamespace } from "../src/namespaces.ts";
import { suitePlan, workerAppPlan } from "../src/plans.ts";

/**
 * The two durable steps in memory: each step's value kept as JSON by its
 * name, as a Workflow keeps it, and read back through its schema, so running
 * the program again over the same `kept` replays it.
 */
const memorySteps = (kept = new Map<string, string>()) => {
  const ran: string[] = [];
  const step = <A>(name: string, schema: Schema.Codec<A, unknown>, run: Effect.Effect<A>) =>
    Effect.gen(function* () {
      const held = kept.get(name);
      if (held !== undefined) return Schema.decodeUnknownSync(schema)(JSON.parse(held));
      const value = yield* run;
      ran.push(name);
      kept.set(name, JSON.stringify(value));
      return value;
    });
  const steps: DepsSteps = {
    need: (run) => step("deps-need", DepsNeed, run),
    build: (install, run) => step(`deps:${install}`, DepsAnswer, run),
  };
  return { kept, ran, steps };
};

/** A candidate's files on a lockfile named by `marker`. */
const candidate = (marker: string, more: Readonly<Record<string, string>> = {}) => ({
  "package.json": '{"name":"candidate"}\n',
  "pnpm-lock.yaml": `lockfileVersion: '9.0'\n# ${marker}\n`,
  "src/a.ts": "export const a = 1;\n",
  ...more,
});

const hexOf = (text: string) =>
  Effect.promise(async () =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );

/**
 * The install digest of a candidate of `files` whose install reads the ones
 * at `paths`, given in path order: the sha256 of the `keel.install/1` line and
 * a `<sha256>  <path>` line for each. Written out here, never taken from core.
 */
const installOf = (files: Readonly<Record<string, string>>, paths: readonly string[]) =>
  Effect.gen(function* () {
    let inputs = "keel.install/1\n";
    for (const path of paths) {
      const text = files[path];
      if (text === undefined) throw new Error(`the candidate holds no ${path}`);
      inputs += `${yield* hexOf(text)}  ${path}\n`;
    }
    return yield* hexOf(inputs);
  });

/** What an install of `candidate`'s files reads: its package.json and its lockfile. */
const READ = ["package.json", "pnpm-lock.yaml"];

const TIER2 = suitePlan().steps;

/** The worker-app plan's two steps moved out of the container, one to each lower tier: a plan with nothing in Tier 2. */
const LOWER: readonly PlanStep[] = workerAppPlan().steps.map((step, i) => ({
  ...step,
  tier: { tier: i === 0 ? 0 : 1, reason: "the test's" },
}));

describe("ensuring a plan's deps", () => {
  it.effect(
    "[deps.ensure.unneeded] a plan with no Tier 2 step needs none: neither step runs and the port is never asked",
    () => {
      const memory = makeDepsBuilderMemory();
      const durable = memorySteps();
      return Effect.gen(function* () {
        const bundle = yield* memory.candidate(sampleNamespace, candidate("unneeded"));
        expect(LOWER.map((step) => step.tier.tier)).toEqual([0, 1]);
        for (const steps of [LOWER, []])
          expect(yield* ensureDeps(sampleNamespace, bundle, steps, durable.steps)).toEqual({
            _tag: "DepsUnneeded",
          });
        expect(durable.ran).toEqual([]);
        expect(memory.asked).toEqual([]);
        expect(memory.built).toEqual([]);
      }).pipe(Effect.provide(memory.layer));
    },
  );

  it.effect(
    "[deps.ensure.built] a plan with a Tier 2 step reads the need, then builds under the step its install digest names",
    () => {
      const memory = makeDepsBuilderMemory();
      const durable = memorySteps();
      return Effect.gen(function* () {
        const files = candidate("built");
        const install = yield* installOf(files, READ);
        const bundle = yield* memory.candidate(sampleNamespace, files);
        const answer = yield* ensureDeps(sampleNamespace, bundle, TIER2, durable.steps);
        if (answer._tag !== "DepsReady") throw new Error(`not ready: ${JSON.stringify(answer)}`);
        expect(answer.install).toBe(install);
        expect(durable.ran).toEqual(["deps-need", `deps:${install}`]);
        expect(memory.built).toMatchObject([
          { namespace: sampleNamespace, bundle, need: { install } },
        ]);
        expect(answer.parts).toEqual([...memory.pointers.values()][0]?.parts);
        expect(answer.parts.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(memory.layer));
    },
  );

  it.effect(
    "[deps.ensure.pointer] a later instance with the same install digest is answered from the pointer and builds nothing; a candidate whose install reads another file is built beside it, neither over the other",
    () => {
      const memory = makeDepsBuilderMemory();
      return Effect.gen(function* () {
        const files = candidate("pointer");
        // This candidate's install digest, written out: the sha256 of the keel.install/1 line and the lines of its package.json and its lockfile.
        const install = "bab834802bf3a7eaced827872af1b228e77b11f45da59073ee11f808b7253b40";
        const first = yield* memory.candidate(sampleNamespace, files);
        const built = yield* ensureDeps(sampleNamespace, first, TIER2, memorySteps().steps);
        expect(built).toMatchObject({ _tag: "DepsReady", install });
        // Another change with the same install inputs, verified by another instance.
        const second = yield* memory.candidate(sampleNamespace, {
          ...files,
          "src/a.ts": "export const a = 2;\n",
        });
        expect(second).not.toBe(first);
        const later = memorySteps();
        expect(yield* ensureDeps(sampleNamespace, second, TIER2, later.steps)).toEqual(built);
        expect(later.ran).toEqual(["deps-need", `deps:${install}`]);
        expect(memory.built).toHaveLength(1);
        // The same candidate in another namespace: that pointer is not theirs, so it is their own build.
        const theirs = yield* memory.candidate(otherNamespace, files);
        yield* ensureDeps(otherNamespace, theirs, TIER2, memorySteps().steps);
        expect(memory.built.map((b) => b.namespace)).toEqual([sampleNamespace, otherNamespace]);
        // The same lockfile under another .npmrc is another install digest: its own step and its own build.
        const resettled = { ...files, ".npmrc": "hoist=false\n" };
        // Written out too: the same text with the line of this .npmrc before the other two.
        const other = "da26924fc8998658c9494ed89b9805a0edd65d60d46e172db3d122f9a3590c65";
        const third = yield* memory.candidate(sampleNamespace, resettled);
        const beside = memorySteps();
        const rebuilt = yield* ensureDeps(sampleNamespace, third, TIER2, beside.steps);
        expect(rebuilt).toMatchObject({ _tag: "DepsReady", install: other });
        expect(beside.ran).toEqual(["deps-need", `deps:${other}`]);
        expect(memory.built.map((b) => [b.namespace, b.need.install])).toEqual([
          [sampleNamespace, install],
          [otherNamespace, install],
          [sampleNamespace, other],
        ]);
        // Beside the first and not over it: every pointer is kept, and each candidate is still answered its own.
        expect(memory.pointers.size).toBe(3);
        expect(yield* ensureDeps(sampleNamespace, first, TIER2, memorySteps().steps)).toEqual(
          built,
        );
        expect(yield* ensureDeps(sampleNamespace, third, TIER2, memorySteps().steps)).toEqual(
          rebuilt,
        );
        expect(memory.built).toHaveLength(3);
      }).pipe(Effect.provide(memory.layer));
    },
  );

  it.effect(
    "[deps.ensure.unlocked] a candidate with no root lockfile is refused with the reason, and the build step never runs",
    () => {
      const memory = makeDepsBuilderMemory();
      const durable = memorySteps();
      return Effect.gen(function* () {
        const bundle = yield* memory.candidate(sampleNamespace, {
          "package.json": "{}\n",
          "packages/x/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        });
        expect(yield* ensureDeps(sampleNamespace, bundle, TIER2, durable.steps)).toEqual({
          _tag: "DepsRefused",
          reason: "no-lockfile: the candidate has no pnpm-lock.yaml at its root",
        });
        expect(durable.ran).toEqual(["deps-need"]);
        expect(memory.asked).toEqual([`need ${bundle}`]);
        expect(memory.built).toEqual([]);
      }).pipe(Effect.provide(memory.layer));
    },
  );

  it.effect(
    "[deps.ensure.too-large] a candidate whose install reads more than a deps box is handed is refused with the reason, and the build step never runs",
    () => {
      const memory = makeDepsBuilderMemory();
      const durable = memorySteps();
      return Effect.gen(function* () {
        // 800 package.json files, each a line of over 80 bytes in the install inputs: more than the 64 KiB a box is handed.
        const bundle = yield* memory.candidate(sampleNamespace, {
          ...candidate("large"),
          ...Object.fromEntries(
            Array.from({ length: 800 }, (_, i) => [
              `packages/p${i}/package.json`,
              `{"name":"p${i}"}\n`,
            ]),
          ),
        });
        expect(yield* ensureDeps(sampleNamespace, bundle, TIER2, durable.steps)).toEqual({
          _tag: "DepsRefused",
          reason:
            "install-inputs-too-large: an install of the candidate reads more files than a deps box is handed",
        });
        expect(durable.ran).toEqual(["deps-need"]);
        expect(memory.asked).toEqual([`need ${bundle}`]);
        expect(memory.built).toEqual([]);
      }).pipe(Effect.provide(memory.layer));
    },
  );

  it.effect(
    "[deps.ensure.bundle-missing] a bundle that is not kept, or kept for another namespace, is unavailable with the reason and builds nothing",
    () => {
      const memory = makeDepsBuilderMemory();
      return Effect.gen(function* () {
        const unkept = Schema.decodeUnknownSync(ContentHash)(`sha256:${"5".repeat(64)}`);
        const theirs = yield* memory.candidate(otherNamespace, candidate("theirs"));
        for (const bundle of [unkept, theirs]) {
          const durable = memorySteps();
          expect(yield* ensureDeps(sampleNamespace, bundle, TIER2, durable.steps)).toEqual({
            _tag: "DepsUnavailable",
            reason: `bundle-missing: the candidate bundle ${bundle} is not kept for ${sampleNamespace}`,
          });
          expect(durable.ran).toEqual(["deps-need"]);
        }
        expect(memory.built).toEqual([]);
      }).pipe(Effect.provide(memory.layer));
    },
  );

  it.effect(
    "[deps.ensure.bundle-unreadable] a bundle whose manifest cannot be read is unavailable with the reason and builds nothing",
    () => {
      const bundle = Schema.decodeUnknownSync(ContentHash)(`sha256:${"6".repeat(64)}`);
      const asked: string[] = [];
      const unreadable = Layer.succeed(
        DepsBuilder,
        DepsBuilder.of({
          need: (_namespace, hash) =>
            Effect.fail(new ManifestUnreadable({ hash, reason: "not gzip, or cut short" })),
          build: (_namespace, need) =>
            Effect.sync(() => {
              asked.push(need.install);
              return { _tag: "DepsUnavailable", reason: "never asked" };
            }),
        }),
      );
      const durable = memorySteps();
      return Effect.gen(function* () {
        expect(yield* ensureDeps(sampleNamespace, bundle, TIER2, durable.steps)).toEqual({
          _tag: "DepsUnavailable",
          reason: "bundle-unreadable: not gzip, or cut short",
        });
        expect(durable.ran).toEqual(["deps-need"]);
        expect(asked).toEqual([]);
      }).pipe(Effect.provide(unreadable));
    },
  );

  it.effect(
    "[deps.ensure.refused] a build the box refuses is unavailable with its reason, kept by the build step",
    () => {
      const memory = makeDepsBuilderMemory();
      const durable = memorySteps();
      return Effect.gen(function* () {
        const files = candidate("refused");
        const install = yield* installOf(files, READ);
        const bundle = yield* memory.candidate(sampleNamespace, files);
        yield* memory.failBuilds(install, "off-registry codeload.github.com");
        expect(yield* ensureDeps(sampleNamespace, bundle, TIER2, durable.steps)).toEqual({
          _tag: "DepsUnavailable",
          reason: "off-registry codeload.github.com",
        });
        expect(durable.ran).toEqual(["deps-need", `deps:${install}`]);
        expect(memory.built).toEqual([]);
      }).pipe(Effect.provide(memory.layer));
    },
  );

  it.effect(
    "[deps.ensure.replay] a replay answers each step's kept value: the port is not asked again, and nothing is built again",
    () => {
      const memory = makeDepsBuilderMemory();
      const kept = new Map<string, string>();
      return Effect.gen(function* () {
        const files = candidate("replay");
        const install = yield* installOf(files, READ);
        const bundle = yield* memory.candidate(sampleNamespace, files);
        const first = memorySteps(kept);
        const answer = yield* ensureDeps(sampleNamespace, bundle, TIER2, first.steps);
        expect(answer).toMatchObject({ _tag: "DepsReady", install });
        expect(first.ran).toEqual(["deps-need", `deps:${install}`]);
        const asked = [...memory.asked];
        // The instance restarts: the same steps, the values they kept.
        const replay = memorySteps(kept);
        expect(yield* ensureDeps(sampleNamespace, bundle, TIER2, replay.steps)).toEqual(answer);
        expect(replay.ran).toEqual([]);
        expect(memory.asked).toEqual(asked);
        expect(memory.built).toHaveLength(1);
        // Cut short after the need was kept: only the build step runs.
        const [need] = [...kept.entries()];
        if (need === undefined) throw new Error("no step was kept");
        const resumed = memorySteps(new Map([need]));
        expect(yield* ensureDeps(sampleNamespace, bundle, TIER2, resumed.steps)).toEqual(answer);
        expect(resumed.ran).toEqual([`deps:${install}`]);
        expect(memory.asked.slice(asked.length)).toEqual([`build ${install}`]);
        expect(memory.built).toHaveLength(1);
      }).pipe(Effect.provide(memory.layer));
    },
  );

  it.effect(
    "[deps.ensure.replay] a replayed refusal is the kept refusal, even once a build would succeed",
    () => {
      const memory = makeDepsBuilderMemory();
      const kept = new Map<string, string>();
      return Effect.gen(function* () {
        // First run: the bundle is not there yet, so the need is kept as unlocked.
        const files = candidate("late");
        const scratch = makeDepsBuilderMemory();
        const bundle = yield* scratch.candidate(sampleNamespace, files);
        const refused = yield* ensureDeps(sampleNamespace, bundle, TIER2, memorySteps(kept).steps);
        expect(refused._tag).toBe("DepsUnavailable");
        // The bundle arrives; the replay still answers what the step kept.
        expect(yield* memory.candidate(sampleNamespace, files)).toBe(bundle);
        const asked = [...memory.asked];
        const replay = memorySteps(kept);
        expect(yield* ensureDeps(sampleNamespace, bundle, TIER2, replay.steps)).toEqual(refused);
        expect(replay.ran).toEqual([]);
        expect(memory.asked).toEqual(asked);
      }).pipe(Effect.provide(memory.layer));
    },
  );
});
