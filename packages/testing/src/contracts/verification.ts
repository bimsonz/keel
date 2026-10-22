import { describe, expect, it } from "@effect/vitest";
import {
  type DepsNeed,
  type GuardFile,
  type ProbeFile,
  storedPlanText,
  WORKER_APP_PACK,
} from "@keeltown/core/application/verification";
import {
  canBlock,
  CommitSha,
  ContentHash,
  contentHashOf,
  makeId,
  type NamespaceId,
  type ProjectId,
  weakest,
} from "@keeltown/core/kernel";
import { DerivedEffect, SubjectKey } from "@keeltown/core/domain/coordination";
import {
  type AdmittedGuard,
  compile,
  type FlowPlan,
  type PlanStep,
  type VerificationJob,
} from "@keeltown/core/domain/verification";
import {
  type BatchVerdict,
  AdmittedGuards,
  BatchVerdicts,
  BundleStore,
  ChangePrecheck,
  DepsBuilder,
  type PrecheckCall,
  EvidenceStore,
  FlowSpecSource,
  PlanStore,
  type PrecheckWorkspace,
  ProbeRunner,
  type ProbeRunRequest,
  ProbeStore,
  type RepoRef,
  VerifierRuntime,
} from "@keeltown/core/ports";
import { Effect, Exit, type Layer, Result, Schema } from "effect";
import { otherNamespace, sampleNamespace } from "../namespaces.ts";
import { suitePlan } from "../plans.ts";
import type { LayerFactory } from "./index.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");

const random = (n: number) =>
  [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const sha256 = async (bytes: Uint8Array) =>
  `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

export function describeBundleStoreContract(adapter: string, make: LayerFactory<BundleStore>) {
  describe(`BundleStore contract: ${adapter}`, () => {
    it.effect("stores bytes under the sha256 of those bytes, and gives them back", () =>
      Effect.gen(function* () {
        const store = yield* BundleStore;
        const bytes = new TextEncoder().encode(`bundle ${random(16)}`);
        const hash = yield* store.put(sampleNamespace, bytes);
        expect(hash).toBe(yield* Effect.promise(() => sha256(bytes)));
        expect(yield* store.put(sampleNamespace, bytes)).toBe(hash);
        expect([...(yield* store.get(sampleNamespace, hash))]).toEqual([...bytes]);
      }).pipe(Effect.provide(make())),
    );
    it.effect("fails BundleMissing for a hash it never stored", () =>
      Effect.gen(function* () {
        const store = yield* BundleStore;
        const missing = Schema.decodeUnknownSync(ContentHash)(`sha256:${random(32)}`);
        const error = yield* Effect.flip(store.get(sampleNamespace, missing));
        expect(error._tag).toBe("BundleMissing");
      }).pipe(Effect.provide(make())),
    );
    it.effect(
      "[t5.bundle-store.namespaces-apart] a bundle kept for one namespace is missing for another, and still there for its own",
      () =>
        Effect.gen(function* () {
          const store = yield* BundleStore;
          const bytes = new TextEncoder().encode(`bundle ${random(16)}`);
          const hash = yield* store.put(sampleNamespace, bytes);
          expect(yield* Effect.flip(store.get(otherNamespace, hash))).toMatchObject({
            _tag: "BundleMissing",
            hash,
          });
          expect([...(yield* store.get(sampleNamespace, hash))]).toEqual([...bytes]);
        }).pipe(Effect.provide(make())),
    );
  });
}

export function describeEvidenceStoreContract(adapter: string, make: LayerFactory<EvidenceStore>) {
  describe(`EvidenceStore contract: ${adapter}`, () => {
    it.effect(
      "stores a document under the hash of its canonical JSON, and gives back an equal one",
      () =>
        Effect.gen(function* () {
          const store = yield* EvidenceStore;
          const document = {
            stepId: "js-ts.suite",
            nonce: random(8),
            failing: [{ file: "a", test: "b" }],
          };
          const hash = yield* store.put(sampleNamespace, document);
          expect(hash).toBe(contentHashOf(document));
          expect(
            yield* store.put(sampleNamespace, {
              failing: document.failing,
              nonce: document.nonce,
              stepId: "js-ts.suite",
            }),
          ).toBe(hash);
          expect(yield* store.get(sampleNamespace, hash)).toEqual(document);
        }).pipe(Effect.provide(make())),
    );
    it.effect("fails EvidenceMissing for a hash it never stored", () =>
      Effect.gen(function* () {
        const store = yield* EvidenceStore;
        const missing = Schema.decodeUnknownSync(ContentHash)(`sha256:${random(32)}`);
        const error = yield* Effect.flip(store.get(sampleNamespace, missing));
        expect(error._tag).toBe("EvidenceMissing");
      }).pipe(Effect.provide(make())),
    );
    it.effect(
      "[t5.evidence-store.namespaces-apart] a document kept for one namespace is missing for another, and still there for its own",
      () =>
        Effect.gen(function* () {
          const store = yield* EvidenceStore;
          const document = { stepId: "js-ts.suite", nonce: random(8) };
          const hash = yield* store.put(sampleNamespace, document);
          expect(yield* Effect.flip(store.get(otherNamespace, hash))).toMatchObject({
            _tag: "EvidenceMissing",
            hash,
          });
          expect(yield* store.get(sampleNamespace, hash)).toEqual(document);
        }).pipe(Effect.provide(make())),
    );
  });
}

export interface PlanStoreHarness {
  readonly layer: Layer.Layer<PlanStore>;
  /** Files raw text under a plan hash in a namespace, as storage at rest might hold it. */
  readonly plant: (namespace: NamespaceId, hash: ContentHash, text: string) => Effect.Effect<void>;
}

/** A worker-app plan on a fresh base, so no two tests share a hash. */
const freshPlan = (): FlowPlan =>
  Result.getOrThrow(
    compile(
      undefined,
      {
        baseCommit: Schema.decodeUnknownSync(CommitSha)(random(20)),
        touchedPaths: ["src/a.ts"],
        subjects: [],
        facts: {},
      },
      WORKER_APP_PACK,
    ),
  );

const textOf = (plan: FlowPlan): string => Result.getOrThrow(storedPlanText(plan));

export function describePlanStoreContract(adapter: string, make: () => PlanStoreHarness) {
  describe(`PlanStore contract: ${adapter}`, () => {
    it.effect(
      "[plan-store.round-trip] keeps a plan under its planHash and gives back an equal one",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const store = yield* PlanStore;
          const plan = freshPlan();
          expect(yield* store.put(sampleNamespace, plan)).toBe(plan.planHash);
          expect(yield* store.put(sampleNamespace, plan)).toBe(plan.planHash);
          expect(yield* store.get(sampleNamespace, plan.planHash)).toEqual(plan);
        }).pipe(Effect.provide(harness.layer));
      },
    );
    it.effect(
      "[t5.plan-store.namespaces-apart] a plan kept for one namespace is missing for another, and still there for its own",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const store = yield* PlanStore;
          const plan = freshPlan();
          yield* store.put(sampleNamespace, plan);
          expect(yield* Effect.flip(store.get(otherNamespace, plan.planHash))).toMatchObject({
            _tag: "PlanMissing",
            hash: plan.planHash,
          });
          expect(yield* store.get(sampleNamespace, plan.planHash)).toEqual(plan);
        }).pipe(Effect.provide(harness.layer));
      },
    );
    it.effect("[plan-store.missing] fails PlanMissing for a hash it never stored", () => {
      const harness = make();
      return Effect.gen(function* () {
        const missing = Schema.decodeUnknownSync(ContentHash)(`sha256:${random(32)}`);
        const error = yield* Effect.flip((yield* PlanStore).get(sampleNamespace, missing));
        expect(error).toMatchObject({ _tag: "PlanMissing", hash: missing });
      }).pipe(Effect.provide(harness.layer));
    });
    it.effect(
      "[plan-store.verified] refuses a plan edited at rest: it no longer rehashes to its key",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const plan = freshPlan();
          const edited = { ...JSON.parse(textOf(plan)), humanClass: !plan.humanClass };
          yield* harness.plant(sampleNamespace, plan.planHash, JSON.stringify(edited));
          const error = yield* Effect.flip((yield* PlanStore).get(sampleNamespace, plan.planHash));
          expect(error).toMatchObject({ _tag: "PlanCorrupt", hash: plan.planHash });
          const dropped = { ...JSON.parse(textOf(plan)), steps: [] };
          yield* harness.plant(sampleNamespace, plan.planHash, JSON.stringify(dropped));
          expect(
            (yield* Effect.flip((yield* PlanStore).get(sampleNamespace, plan.planHash)))._tag,
          ).toBe("PlanCorrupt");
        }).pipe(Effect.provide(harness.layer));
      },
    );
    it.effect("[plan-store.keyed] refuses a genuine plan filed under another plan's hash", () => {
      const harness = make();
      return Effect.gen(function* () {
        const [wanted, other] = [freshPlan(), freshPlan()];
        yield* harness.plant(sampleNamespace, wanted.planHash, textOf(other));
        const error = yield* Effect.flip((yield* PlanStore).get(sampleNamespace, wanted.planHash));
        expect(error).toMatchObject({ _tag: "PlanCorrupt", hash: wanted.planHash });
      }).pipe(Effect.provide(harness.layer));
    });
    it.effect("refuses text that is not a plan", () => {
      const harness = make();
      return Effect.gen(function* () {
        const store = yield* PlanStore;
        for (const text of ["not json", "{}", JSON.stringify({ planHash: "sha256:x" })]) {
          const hash = Schema.decodeUnknownSync(ContentHash)(`sha256:${random(32)}`);
          yield* harness.plant(sampleNamespace, hash, text);
          expect((yield* Effect.flip(store.get(sampleNamespace, hash)))._tag).toBe("PlanCorrupt");
        }
      }).pipe(Effect.provide(harness.layer));
    });
    it.effect("[plan-store.refuses-lying-plan] never stores a plan whose own hash lies", () => {
      const harness = make();
      return Effect.gen(function* () {
        const store = yield* PlanStore;
        const plan = freshPlan();
        const lying = { ...plan, humanClass: !plan.humanClass };
        expect(Exit.isFailure(yield* Effect.exit(store.put(sampleNamespace, lying)))).toBe(true);
        expect((yield* Effect.flip(store.get(sampleNamespace, plan.planHash)))._tag).toBe(
          "PlanMissing",
        );
      }).pipe(Effect.provide(harness.layer));
    });
  });
}

export interface ProbeStoreHarness {
  readonly layer: Layer.Layer<ProbeStore>;
  /** The files stored under a hash for a namespace, as a VerifierDO would read them back; none when nothing is. */
  readonly read: (
    namespace: NamespaceId,
    hash: ContentHash,
  ) => Effect.Effect<readonly ProbeFile[] | undefined>;
}

const byPath = (files: readonly ProbeFile[]) =>
  files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** A probe of two files, one carrying `marker`. */
const probeFiles = (marker: string): ProbeFile[] => [
  { path: ".keel/freshness.test.ts", text: `import { it } from "vitest";\n// ${marker}\n` },
  {
    path: ".keel/support/actors.ts",
    text: `export const marker = ${JSON.stringify(marker)};\n`,
  },
];

export function describeProbeStoreContract(adapter: string, make: () => ProbeStoreHarness) {
  describe(`ProbeStore contract: ${adapter}`, () => {
    it.effect(
      "[probe-store.round-trip] keeps a probe's files under a content hash and reads them back",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const put = probeFiles(random(8));
          const hash = yield* (yield* ProbeStore).put(sampleNamespace, put);
          expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
          const read = yield* harness.read(sampleNamespace, hash);
          expect(read === undefined ? undefined : byPath(read)).toEqual(byPath(put));
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[probe-store.get] reads a kept probe's files back through the port, and fails BundleMissing for a hash nothing is kept under",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const store = yield* ProbeStore;
          const [first, second] = [probeFiles(random(8)), probeFiles(random(8))];
          const hash = yield* store.put(sampleNamespace, first.toReversed());
          yield* store.put(sampleNamespace, second);
          const unkept = ContentHash.make(`sha256:${"0".repeat(64)}`);

          expect(byPath(yield* store.get(sampleNamespace, hash))).toEqual(byPath(first));
          expect(yield* Effect.flip(store.get(sampleNamespace, unkept))).toMatchObject({
            _tag: "BundleMissing",
            hash: unkept,
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[t5.probe-store.namespaces-apart] a probe kept for one namespace is missing for another, through the port and where a VerifierDO reads",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const store = yield* ProbeStore;
          const put = probeFiles(random(8));
          const hash = yield* store.put(sampleNamespace, put);
          expect(yield* Effect.flip(store.get(otherNamespace, hash))).toMatchObject({
            _tag: "BundleMissing",
            hash,
          });
          expect(yield* harness.read(otherNamespace, hash)).toBeUndefined();
          expect(byPath(yield* store.get(sampleNamespace, hash))).toEqual(byPath(put));
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[probe-store.stable] the same files in any order answer one hash, and other text another",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const store = yield* ProbeStore;
          const marker = random(8);
          const hash = yield* store.put(sampleNamespace, probeFiles(marker));
          expect(yield* store.put(sampleNamespace, probeFiles(marker).toReversed())).toBe(hash);
          expect(yield* store.put(sampleNamespace, probeFiles(`${marker}!`))).not.toBe(hash);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}

export interface AdmittedGuardsHarness {
  readonly layer: Layer.Layer<AdmittedGuards>;
  /** Puts a guard the repo holds but cannot admit to a plan: its guard.json names no proposition. */
  readonly plantWithoutProposition: (projectId: ProjectId, guardId: string) => Effect.Effect<void>;
}

const freshGuard = (subject: string): GuardFile => ({
  guardId: makeId("grd", ulid()),
  probe: contentHashOf({ probe: subject }),
  proposition: {
    subject: Schema.decodeUnknownSync(SubjectKey)(subject),
    predicate: "freshness",
    relation: "at-most",
    value: "per-request",
    anchors: [{ path: "src/sessions.ts", commit: CommitSha.make("a".repeat(40)) }],
  },
});

/** The probe a guard is admitted with, as the guard repo keeps it beside guard.json. */
const PROBE_FILES: readonly ProbeFile[] = [
  { path: ".keel/freshness.test.ts", text: "// the admitted probe\n" },
];

/** What a list gives back of an admitted guard. */
const listedAs = (g: AdmittedGuard | GuardFile) => ({
  guardId: g.guardId,
  probe: g.probe,
  proposition: "tenet" in g ? g.tenet.proposition : g.proposition,
});

const byGuardId = (x: { readonly guardId: string }, y: { readonly guardId: string }) =>
  x.guardId.localeCompare(y.guardId);

export function describeAdmittedGuardsContract(adapter: string, make: () => AdmittedGuardsHarness) {
  describe(`AdmittedGuards contract: ${adapter}`, () => {
    it.effect("[admitted-guards.none] a project that admitted no guard lists none", () => {
      const harness = make();
      return Effect.gen(function* () {
        const list = yield* (yield* AdmittedGuards).list(freshId("prj"));
        expect(list).toEqual({ admitted: [], refused: [] });
      }).pipe(Effect.provide(harness.layer));
    });

    it.effect(
      "[admitted-guards.listed] lists each guard admitted, with its probe and the proposition it guards, and only the project's own",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const guards = yield* AdmittedGuards;
          const projectId = freshId("prj");
          const [a, b] = [freshGuard("authz.sessions"), freshGuard("authz.tokens")];
          yield* guards.admit(projectId, a, PROBE_FILES);
          yield* guards.admit(projectId, b, PROBE_FILES);
          yield* guards.admit(freshId("prj"), freshGuard("billing.invoices"), PROBE_FILES);
          const list = yield* guards.list(projectId);
          expect(list.admitted.map(listedAs).toSorted(byGuardId)).toEqual(
            [a, b].map(listedAs).toSorted(byGuardId),
          );
          expect(list.refused).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[admitted-guards.admit-once] admitting a guard the repo already holds as written commits nothing and answers the repo's head",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const guards = yield* AdmittedGuards;
          const projectId = freshId("prj");
          const [a, b] = [freshGuard("authz.sessions"), freshGuard("authz.tokens")];
          const first = yield* guards.admit(projectId, a, PROBE_FILES);
          expect(yield* guards.admit(projectId, a, PROBE_FILES)).toBe(first);
          const second = yield* guards.admit(projectId, b, PROBE_FILES);
          expect(second).not.toBe(first);
          expect(yield* guards.admit(projectId, a, PROBE_FILES)).toBe(second);
          expect(yield* guards.admit(projectId, b, PROBE_FILES)).toBe(second);
          expect((yield* guards.list(projectId)).admitted.map((g) => g.guardId).toSorted()).toEqual(
            [a.guardId, b.guardId].toSorted(),
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[admitted-guards.refused] a guard whose guard.json names no proposition is refused with its reason, never skipped",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const guards = yield* AdmittedGuards;
          const projectId = freshId("prj");
          const good = freshGuard("authz.sessions");
          const bad = makeId("grd", ulid());
          yield* guards.admit(projectId, good, PROBE_FILES);
          yield* harness.plantWithoutProposition(projectId, bad);
          const list = yield* guards.list(projectId);
          expect(list.admitted.map((g) => g.guardId)).toEqual([good.guardId]);
          expect(list.refused).toEqual([
            { guardId: bad, reason: expect.stringMatching(/proposition/) },
          ]);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}

export interface ProbeRunnerHarness {
  readonly layer: Layer.Layer<ProbeRunner>;
  /** Requests the harness prepared so the probe reports each answer. */
  readonly prepared: Readonly<Record<"pass" | "fail" | "n/a" | "harness-error", ProbeRunRequest>>;
}

export function describeProbeRunnerContract(adapter: string, make: () => ProbeRunnerHarness) {
  describe(`ProbeRunner contract: ${adapter}`, () => {
    it.effect(
      "[probe-runner.reports] answers each run with what the probe reported, n/a as n/a",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const runner = yield* ProbeRunner;
          for (const outcome of ["pass", "fail", "n/a"] as const)
            expect(yield* runner.run(harness.prepared[outcome])).toMatchObject({
              _tag: "ran",
              outcome,
            });
        }).pipe(Effect.provide(harness.layer));
      },
    );
    it.effect(
      "[probe-runner.ready] answers a world a probe runs against as ready, before any probe is run",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const runner = yield* ProbeRunner;
          const { namespace, worldBundle } = harness.prepared.pass;
          expect(yield* runner.ready({ namespace, worldBundle })).toEqual({ _tag: "Ready" });
          expect(yield* runner.run(harness.prepared.pass)).toMatchObject({ outcome: "pass" });
        }).pipe(Effect.provide(harness.layer));
      },
    );
    it.effect(
      "[probe-runner.harness-error] answers a broken probe as a harness error, never an outcome",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const answer = yield* (yield* ProbeRunner).run(harness.prepared["harness-error"]);
          expect(answer._tag).toBe("harness-error");
          expect(answer.reason.length).toBeGreaterThan(0);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}

/** A DepsBuilder, and what its suite needs beside it: candidates to build from, a build that fails, and a count. */
export interface DepsBuilderHarness {
  readonly layer: Layer.Layer<DepsBuilder>;
  /** Keeps a candidate bundle of these files (path to text) for `namespace`, and answers its address. */
  readonly candidate: (
    namespace: NamespaceId,
    files: Readonly<Record<string, string>>,
  ) => Effect.Effect<ContentHash>;
  /** Makes every build for this install digest end refused with `reason`, as a deps box that cannot make it does. */
  readonly failBuilds: (install: string, reason: string) => Effect.Effect<void>;
  /** How many builds have run for the namespace's install digest. A pointer that served ran none. */
  readonly builds: (namespace: NamespaceId, install: string) => Effect.Effect<number>;
}

const hexOf = async (text: string) =>
  (await sha256(new TextEncoder().encode(text))).slice("sha256:".length);

/** A candidate's files on a fresh lockfile, so no two tests share a deps bundle. */
const candidateFiles = (settings: Readonly<Record<string, string>> = {}) => ({
  ...settings,
  "package.json": '{"name":"candidate"}\n',
  "pnpm-lock.yaml": `lockfileVersion: '9.0'\n# ${random(8)}\n`,
  "src/a.ts": "export const a = 1;\n",
});

/** A candidate of these files kept for the sample namespace, and what it needs. */
const keptCandidate = (harness: DepsBuilderHarness, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const bundle = yield* harness.candidate(sampleNamespace, files);
    const need = yield* (yield* DepsBuilder).need(sampleNamespace, bundle);
    if (need._tag !== "Locked") throw new Error(`the candidate is unlocked: ${need.reason}`);
    return { bundle, need };
  });

export function describeDepsBuilderContract(adapter: string, make: () => DepsBuilderHarness) {
  describe(`DepsBuilder contract: ${adapter}`, () => {
    it.effect(
      "[deps-builder.need] answers what a kept candidate needs: the files an install reads, each with its sha256 in path order, and the sha256 of that text",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const files = {
            ...candidateFiles(),
            ".npmrc": "auto-install-peers=true\n",
            "packages/x/package.json": '{"name":"x"}\n',
            "packages/x/pnpm-lock.yaml": "not the lockfile\n",
          };
          const bundle = yield* harness.candidate(sampleNamespace, files);
          const line = (path: keyof typeof files) =>
            Effect.promise(async () => `${await hexOf(files[path])}  ${path}\n`);
          // Written out, never taken from core: the lockfile, the settings file and both package.json, and no other file.
          const inputs = [
            "keel.install/1\n",
            yield* line(".npmrc"),
            yield* line("package.json"),
            yield* line("packages/x/package.json"),
            yield* line("pnpm-lock.yaml"),
          ].join("");
          expect(yield* (yield* DepsBuilder).need(sampleNamespace, bundle)).toEqual({
            _tag: "Locked",
            install: yield* Effect.promise(() => hexOf(inputs)),
            inputs,
          } satisfies DepsNeed);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[deps-builder.need-commands] reads each package.json of the bundle for the commands it declares: a bin's file the bundle holds is an install input, and a file none declares is not",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const files = {
            ...candidateFiles(),
            "cli.js": "#!/usr/bin/env node\n",
            "package.json": '{"name":"candidate","bin":"./cli.js"}\n',
            "packages/x/bin/x.js": "#!/usr/bin/env node\nconsole.log('x');\n",
            "packages/x/package.json": '{"name":"x","bin":{"x":"bin/x.js"}}\n',
            "packages/x/src/index.js": "export const x = 1;\n",
          };
          const { need } = yield* keptCandidate(harness, files);
          // Written out, never taken from core: with `over`, the bytes one of the files holds instead.
          const needing = (over: Readonly<Record<string, string>> = {}) =>
            Effect.promise(async () => {
              const line = async (path: keyof typeof files) =>
                `${await hexOf(over[path] ?? files[path])}  ${path}\n`;
              const inputs = [
                "keel.install/1\n",
                await line("cli.js"),
                await line("package.json"),
                await line("packages/x/bin/x.js"),
                await line("packages/x/package.json"),
                await line("pnpm-lock.yaml"),
              ].join("");
              return { _tag: "Locked", install: await hexOf(inputs), inputs } satisfies DepsNeed;
            });
          expect(need).toEqual(yield* needing());
          // An edit to a command's file is another digest: pnpm reads the file to write its shim.
          const shebang = { "packages/x/bin/x.js": "#!/usr/bin/env bun\nconsole.log('x');\n" };
          const edited = yield* keptCandidate(harness, { ...files, ...shebang });
          expect(edited.need).toEqual(yield* needing(shebang));
          // An edit to a file no package.json declares is the same need.
          const source = yield* keptCandidate(harness, {
            ...files,
            "packages/x/src/index.js": "export const x = 2;\n",
          });
          expect(source.need).toEqual(need);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[deps-builder.need-unlocked] answers a kept candidate with no lockfile at its root as Unlocked, with the reason",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const bundle = yield* harness.candidate(sampleNamespace, {
            "package.json": '{"name":"candidate"}\n',
            "packages/x/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
          });
          expect(yield* (yield* DepsBuilder).need(sampleNamespace, bundle)).toEqual({
            _tag: "Unlocked",
            reason: "no-lockfile: the candidate has no pnpm-lock.yaml at its root",
          } satisfies DepsNeed);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[deps-builder.missing] fails BundleMissing for a bundle it does not keep, and for one kept for another namespace",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const builder = yield* DepsBuilder;
          const unkept = Schema.decodeUnknownSync(ContentHash)(`sha256:${random(32)}`);
          expect(yield* Effect.flip(builder.need(sampleNamespace, unkept))).toMatchObject({
            _tag: "BundleMissing",
            hash: unkept,
          });
          const bundle = yield* harness.candidate(sampleNamespace, candidateFiles());
          expect(yield* Effect.flip(builder.need(otherNamespace, bundle))).toMatchObject({
            _tag: "BundleMissing",
            hash: bundle,
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[deps-builder.builds-once] builds an install digest's deps once: the same need is answered the same parts again, from any bundle whose install reads the same files",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const builder = yield* DepsBuilder;
          const files = candidateFiles();
          const { bundle, need } = yield* keptCandidate(harness, files);
          const first = yield* builder.build(sampleNamespace, need, bundle);
          if (first._tag !== "DepsReady") throw new Error(`not built: ${JSON.stringify(first)}`);
          expect(first.install).toBe(need.install);
          expect(first.parts.length).toBeGreaterThan(0);
          for (const part of first.parts) {
            expect(part.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(part.bytes).toBeGreaterThan(0);
          }
          expect(yield* builder.build(sampleNamespace, need, bundle)).toEqual(first);
          // Another candidate with the same install inputs: other source, the same deps.
          const edited = yield* keptCandidate(harness, {
            ...files,
            "src/a.ts": "export const a = 2;\n",
          });
          expect(edited.bundle).not.toBe(bundle);
          expect(edited.need).toEqual(need);
          expect(yield* builder.build(sampleNamespace, edited.need, edited.bundle)).toEqual(first);
          expect(yield* harness.builds(sampleNamespace, need.install)).toBe(1);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[deps-builder.side-by-side] a candidate whose settings file or package.json is another, absent or new has its own deps beside the others: each is built once, and none over another",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const builder = yield* DepsBuilder;
          const files = candidateFiles();
          const candidates = [
            yield* keptCandidate(harness, files),
            yield* keptCandidate(harness, { ...files, ".npmrc": "hoist=false\n" }),
            yield* keptCandidate(harness, {
              ...files,
              "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
            }),
            yield* keptCandidate(harness, {
              ...files,
              "package.json": '{"name":"candidate","bin":"cli.js"}\n',
            }),
            yield* keptCandidate(harness, {
              ...files,
              "packages/x/package.json": '{"name":"x"}\n',
            }),
          ];
          expect(new Set(candidates.map((c) => c.need.install)).size).toBe(candidates.length);
          const firsts = [];
          for (const candidate of candidates)
            firsts.push(yield* builder.build(sampleNamespace, candidate.need, candidate.bundle));
          expect(new Set(firsts.map((answer) => JSON.stringify(answer))).size).toBe(
            candidates.length,
          );
          // Every one is still served what it was first answered: no build wrote over another's.
          for (const [n, candidate] of candidates.entries()) {
            expect(firsts[n]?._tag).toBe("DepsReady");
            expect(yield* builder.build(sampleNamespace, candidate.need, candidate.bundle)).toEqual(
              firsts[n],
            );
            expect(yield* harness.builds(sampleNamespace, candidate.need.install)).toBe(1);
          }
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[deps-builder.namespaces-apart] deps built for one namespace are not another's: it runs its own build for the same install digest",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const builder = yield* DepsBuilder;
          const files = candidateFiles();
          const { bundle, need } = yield* keptCandidate(harness, files);
          yield* builder.build(sampleNamespace, need, bundle);
          expect(yield* harness.builds(otherNamespace, need.install)).toBe(0);
          const theirs = yield* harness.candidate(otherNamespace, files);
          const answer = yield* builder.build(otherNamespace, need, theirs);
          expect(answer._tag).toBe("DepsReady");
          expect(yield* harness.builds(otherNamespace, need.install)).toBe(1);
          expect(yield* harness.builds(sampleNamespace, need.install)).toBe(1);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[deps-builder.unavailable] answers a build that cannot be made as DepsUnavailable with its reason, and keeps nothing of it",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const builder = yield* DepsBuilder;
          const { bundle, need } = yield* keptCandidate(harness, candidateFiles());
          const reason = `install-failed ${random(4)}`;
          yield* harness.failBuilds(need.install, reason);
          const refused = { _tag: "DepsUnavailable", reason };
          expect(yield* builder.build(sampleNamespace, need, bundle)).toEqual(refused);
          // No pointer came of it: the next call is refused again, never served.
          expect(yield* builder.build(sampleNamespace, need, bundle)).toEqual(refused);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[deps-builder.unavailable] a build from a bundle the namespace does not keep is unavailable, and builds nothing",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const builder = yield* DepsBuilder;
          const { need } = yield* keptCandidate(harness, candidateFiles());
          const unkept = Schema.decodeUnknownSync(ContentHash)(`sha256:${random(32)}`);
          const answer = yield* builder.build(sampleNamespace, need, unkept);
          expect(answer._tag).toBe("DepsUnavailable");
          expect(yield* harness.builds(sampleNamespace, need.install)).toBe(0);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}

const probeStep: PlanStep = {
  id: "contract.probe",
  kind: "probe",
  evidenceCeiling: "proof",
  appliesTo: [],
  tier: { tier: 1, reason: "a probe runs in an isolate" },
  because: "the contract",
  outcomes: ["pass", "fail", "abstain"],
};

/** A job with the js-ts suite and a probe: every adapter answers each step, whatever it can run. */
export const contractJob = (): VerificationJob => ({
  jobId: `job-${random(6)}`,
  bundle: Schema.decodeUnknownSync(ContentHash)(`sha256:${random(32)}`),
  steps: [...suitePlan().steps, probeStep],
  fence: { batchId: makeId("bat", ulid()), attempt: 1, chainEpoch: 0 },
});

export function describeVerifierRuntimeContract(
  adapter: string,
  make: LayerFactory<VerifierRuntime>,
) {
  describe(`VerifierRuntime contract: ${adapter}`, () => {
    it.effect(
      "answers every step once, in order, on its tier, never above its ceiling or outside its outcomes",
      () =>
        Effect.gen(function* () {
          const runtime = yield* VerifierRuntime;
          const job = contractJob();
          const results = yield* runtime.run(sampleNamespace, job, { _tag: "DepsUnneeded" });
          expect(results.map((r) => r.stepId)).toEqual(job.steps.map((s) => s.id));
          for (const [i, r] of results.entries()) {
            const step = job.steps[i];
            if (step === undefined) throw new Error("result without a step");
            expect(r.tier).toEqual(step.tier);
            expect(weakest(r.evidenceClass, step.evidenceCeiling)).toBe(r.evidenceClass);
            expect([...(step.outcomes ?? []), "abstain"]).toContain(r.outcome);
            if (r.outcome === "pass" || r.outcome === "fail")
              expect(canBlock(r.evidenceClass)).toBe(true);
          }
        }).pipe(Effect.provide(make())),
    );
  });
}

/** A lane with one formed batch of one change, which `record` can be called against. */
export interface BatchVerdictsHarness {
  readonly layer: Layer.Layer<BatchVerdicts>;
  readonly laneId: string;
  readonly fence: BatchVerdict["fence"];
  readonly candidateId: BatchVerdict["candidateId"];
}

const verdictFor = (h: BatchVerdictsHarness, instanceId: string): BatchVerdict => ({
  instanceId,
  fence: h.fence,
  candidateId: h.candidateId,
  verdictId: makeId("vrd", ulid()),
  outcome: "land",
  planHash: suitePlan().planHash,
  evidence: ["js-ts.suite: pass"],
  failingTests: [],
});

export function describeBatchVerdictsContract(
  adapter: string,
  harness: () => BatchVerdictsHarness,
) {
  describe(`BatchVerdicts contract: ${adapter}`, () => {
    it.effect("records a verdict once per instance: a replay is not an error", () => {
      const h = harness();
      return Effect.gen(function* () {
        const verdicts = yield* BatchVerdicts;
        const v = verdictFor(h, `keel-verify-${random(6)}`);
        yield* verdicts.record(h.laneId, v);
        yield* verdicts.record(h.laneId, v);
      }).pipe(Effect.provide(h.layer));
    });

    it.effect("fences a result for another attempt or chain epoch", () => {
      const h = harness();
      return Effect.gen(function* () {
        const verdicts = yield* BatchVerdicts;
        const v = verdictFor(h, `keel-verify-${random(6)}`);
        for (const fence of [
          { ...h.fence, attempt: h.fence.attempt + 1 },
          { ...h.fence, chainEpoch: h.fence.chainEpoch + 1 },
        ]) {
          const error = yield* Effect.flip(verdicts.record(h.laneId, { ...v, fence }));
          expect(error._tag).toBe("ResultFenced");
        }
      }).pipe(Effect.provide(h.layer));
    });

    it.effect("refuses a candidate the batch does not hold", () => {
      const h = harness();
      return Effect.gen(function* () {
        const verdicts = yield* BatchVerdicts;
        const v = verdictFor(h, `keel-verify-${random(6)}`);
        const stranger = makeId("cnd", ulid());
        const error = yield* Effect.flip(
          verdicts.record(h.laneId, { ...v, candidateId: stranger }),
        );
        expect(error._tag).toBe("CandidateNotFound");
      }).pipe(Effect.provide(h.layer));
    });

    it.effect(
      "[steps.contract] takes a step's start and result, again on a replay; fences a step for another attempt or chain epoch, and refuses one for a candidate the batch does not hold",
      () => {
        const h = harness();
        return Effect.gen(function* () {
          const verdicts = yield* BatchVerdicts;
          const tier = { tier: 2 as const, reason: "a suite runs in a box" };
          const started = {
            instanceId: `keel-verify-${random(6)}`,
            fence: h.fence,
            candidateId: h.candidateId,
            step: {
              _tag: "Started" as const,
              stepId: "js-ts.suite",
              kind: "deterministic" as const,
              tier,
            },
          };
          yield* verdicts.recordStep(h.laneId, started);
          yield* verdicts.recordStep(h.laneId, started);
          yield* verdicts.recordStep(h.laneId, {
            ...started,
            step: {
              _tag: "Finished",
              stepId: "js-ts.suite",
              outcome: "pass",
              evidenceClass: "proof",
              tier,
              durationMs: 4210,
            },
          });
          for (const fence of [
            { ...h.fence, attempt: h.fence.attempt + 1 },
            { ...h.fence, chainEpoch: h.fence.chainEpoch + 1 },
          ]) {
            const error = yield* Effect.flip(verdicts.recordStep(h.laneId, { ...started, fence }));
            expect(error._tag).toBe("ResultFenced");
          }
          const stranger = makeId("cnd", ulid());
          const error = yield* Effect.flip(
            verdicts.recordStep(h.laneId, { ...started, candidateId: stranger }),
          );
          expect(error._tag).toBe("CandidateNotFound");
        }).pipe(Effect.provide(h.layer));
      },
    );
  });
}

/** A fresh id for harnesses to seed batches and candidates with. */
export const freshId = <P extends "bat" | "cnd" | "chg" | "prj">(prefix: P) =>
  makeId(prefix, ulid());

export interface ChangePrecheckHarness {
  readonly layer: Layer.Layer<ChangePrecheck>;
  /** A change just submitted: its id, its revision, the commit it carries, and the workspace it holds. */
  readonly submitted: () => Effect.Effect<{
    readonly changeId: ReturnType<typeof freshId<"chg">>;
    readonly revision: number;
    readonly commitSha: CommitSha;
    readonly workspace: PrecheckWorkspace;
  }>;
}

const PLAN = {
  planHash: contentHashOf({ plan: "the ChangePrecheck contract's" }),
  steps: 1,
  costEstimate: 0.01,
  predicatePolicy: { freshness: "block" as const },
};
const REFUSAL = {
  reasons: ["precheck:protected:src/secret.ts (src/secret*)"] as const,
  nextActions: [{ kind: "call" as const, title: "Submit again", operationId: "submit" }] as const,
};
/** What a derive step found: one effect no intent declared, as the extractor rules on it. */
const DERIVATION = {
  effects: [
    Schema.decodeUnknownSync(DerivedEffect)({
      proposition: {
        subject: "authz.permission-evaluation",
        predicate: "freshness",
        relation: "is",
        value: "per-session",
      },
      anchors: [{ path: "src/authz/evaluate.ts", symbol: "evaluate", commit: "c".repeat(40) }],
      declared: false,
      method: "extractor",
      evidenceClass: "ruling",
    }),
  ],
  derivationRef: "derivation-1",
};

export function describeChangePrecheckContract(
  adapter: string,
  harness: () => ChangePrecheckHarness,
) {
  describe(`ChangePrecheck contract: ${adapter}`, () => {
    it.effect("answers the workspace a submitted change holds", () => {
      const h = harness();
      return Effect.gen(function* () {
        const { changeId, workspace } = yield* h.submitted();
        expect(yield* (yield* ChangePrecheck).workspace(changeId)).toEqual(workspace);
      }).pipe(Effect.provide(h.layer));
    });

    it.effect("is ChangeNotFound on every step for a change that was never declared", () => {
      const h = harness();
      return Effect.gen(function* () {
        const changes = yield* ChangePrecheck;
        const unknown = freshId("chg");
        const call = { revision: 1, instanceId: `precheck-${random(6)}` };
        const tags = [
          yield* Effect.flip(changes.workspace(unknown)),
          yield* Effect.flip(
            changes.started(unknown, { ...call, commitSha: CommitSha.make("c".repeat(40)) }),
          ),
          yield* Effect.flip(changes.derived(unknown, { ...call, ...DERIVATION })),
          yield* Effect.flip(changes.refused(unknown, { ...call, ...REFUSAL })),
          yield* Effect.flip(changes.compiled(unknown, { ...call, ...PLAN })),
        ].map((e) => e._tag);
        expect(tags).toEqual([
          "ChangeNotFound",
          "ChangeNotFound",
          "ChangeNotFound",
          "ChangeNotFound",
          "ChangeNotFound",
        ]);
      }).pipe(Effect.provide(h.layer));
    });

    it.effect(
      "refuses a stale revision with ChangeStateRefused, and the change does not move",
      () => {
        const h = harness();
        return Effect.gen(function* () {
          const changes = yield* ChangePrecheck;
          const { changeId, revision, commitSha } = yield* h.submitted();
          const instanceId = `precheck-${random(6)}`;
          const stale = yield* Effect.flip(
            changes.started(changeId, { revision: revision + 1, instanceId, commitSha }),
          );
          expect(stale._tag).toBe("ChangeStateRefused");
          // Still submitted: the current revision starts.
          yield* changes.started(changeId, { revision, instanceId, commitSha });
        }).pipe(Effect.provide(h.layer));
      },
    );

    it.effect(
      "takes a submission to its plan once: a replayed step commits nothing new, another instance is refused",
      () => {
        const h = harness();
        return Effect.gen(function* () {
          const changes = yield* ChangePrecheck;
          const { changeId, revision, commitSha } = yield* h.submitted();
          const call = { revision, instanceId: `precheck-${random(6)}` };
          yield* changes.started(changeId, { ...call, commitSha });
          yield* changes.started(changeId, { ...call, commitSha });
          yield* changes.compiled(changeId, { ...call, ...PLAN });
          yield* changes.compiled(changeId, { ...call, ...PLAN });
          const other = { revision, instanceId: `precheck-${random(6)}`, commitSha };
          expect((yield* Effect.flip(changes.started(changeId, other)))._tag).toBe(
            "ChangeStateRefused",
          );
        }).pipe(Effect.provide(h.layer));
      },
    );

    it.effect(
      "[b21.effects-derived] records one derivation a pass: its replay commits nothing new, a second is refused, and the plan still compiles",
      () => {
        const h = harness();
        return Effect.gen(function* () {
          const changes = yield* ChangePrecheck;
          const { changeId, revision, commitSha } = yield* h.submitted();
          const call = { revision, instanceId: `precheck-${random(6)}` };
          yield* changes.started(changeId, { ...call, commitSha });
          yield* changes.derived(changeId, { ...call, ...DERIVATION });
          yield* changes.derived(changeId, { ...call, ...DERIVATION });
          const second = { revision, instanceId: `precheck-${random(6)}` };
          expect(
            (yield* Effect.flip(changes.derived(changeId, { ...second, ...DERIVATION })))._tag,
          ).toBe("ChangeStateRefused");
          yield* changes.compiled(changeId, { ...call, ...PLAN });
        }).pipe(Effect.provide(h.layer));
      },
    );

    it.effect(
      "[b21.effects-derived] refuses a derivation for a stale revision, before the pass starts, after the plan, and for a change never declared",
      () => {
        const h = harness();
        return Effect.gen(function* () {
          const changes = yield* ChangePrecheck;
          const { changeId, revision, commitSha } = yield* h.submitted();
          const call = { revision, instanceId: `precheck-${random(6)}` };
          const tagOf = (derived: PrecheckCall) =>
            Effect.map(
              Effect.flip(changes.derived(changeId, { ...derived, ...DERIVATION })),
              (refusal) => refusal._tag,
            );
          const early = yield* tagOf({ revision, instanceId: `precheck-${random(6)}` });
          yield* changes.started(changeId, { ...call, commitSha });
          const stale = yield* tagOf({ revision: revision + 1, instanceId: call.instanceId });
          // The stale call moved nothing: the current revision still derives.
          yield* changes.derived(changeId, { ...call, ...DERIVATION });
          yield* changes.compiled(changeId, { ...call, ...PLAN });
          const late = yield* tagOf({ revision, instanceId: `precheck-${random(6)}` });
          const unknown = yield* Effect.flip(
            changes.derived(freshId("chg"), { ...call, ...DERIVATION }),
          );
          expect([early, stale, late, unknown._tag]).toEqual([
            "ChangeStateRefused",
            "ChangeStateRefused",
            "ChangeStateRefused",
            "ChangeNotFound",
          ]);
        }).pipe(Effect.provide(h.layer));
      },
    );

    it.effect(
      "answers a refusal's verdict, the same one on a replay, and then compiles nothing",
      () => {
        const h = harness();
        return Effect.gen(function* () {
          const changes = yield* ChangePrecheck;
          const { changeId, revision, commitSha } = yield* h.submitted();
          const call = { revision, instanceId: `precheck-${random(6)}` };
          yield* changes.started(changeId, { ...call, commitSha });
          const verdictId = yield* changes.refused(changeId, { ...call, ...REFUSAL });
          expect(verdictId).toMatch(/^vrd_/);
          expect(yield* changes.refused(changeId, { ...call, ...REFUSAL })).toBe(verdictId);
          expect((yield* Effect.flip(changes.compiled(changeId, { ...call, ...PLAN })))._tag).toBe(
            "ChangeStateRefused",
          );
        }).pipe(Effect.provide(h.layer));
      },
    );

    it.effect(
      "[precheck.contract.run-bound] a run starts only for the commit the change carries, and past its start only the current pass's run moves it: another run's derivation, refusal and plan are refused",
      () => {
        const h = harness();
        return Effect.gen(function* () {
          const changes = yield* ChangePrecheck;
          const { changeId, revision, commitSha } = yield* h.submitted();
          const moved = CommitSha.make("e".repeat(40));
          const call = { revision, instanceId: `precheck-${random(6)}` };
          const elsewhere = yield* Effect.flip(
            changes.started(changeId, { ...call, commitSha: moved }),
          );
          yield* changes.started(changeId, { ...call, commitSha });
          const other = { revision, instanceId: `precheck-${random(6)}` };
          const tags = [
            elsewhere,
            yield* Effect.flip(changes.derived(changeId, { ...other, ...DERIVATION })),
            yield* Effect.flip(changes.refused(changeId, { ...other, ...REFUSAL })),
            yield* Effect.flip(changes.compiled(changeId, { ...other, ...PLAN })),
          ].map((e) => e._tag);
          expect(tags).toEqual([
            "ChangeStateRefused",
            "ChangeStateRefused",
            "ChangeStateRefused",
            "ChangeStateRefused",
          ]);
          // None of them moved it: the current pass still compiles.
          yield* changes.compiled(changeId, { ...call, ...PLAN });
        }).pipe(Effect.provide(h.layer));
      },
    );
  });
}

/** Paths in code-unit order, as git sorts them. */
const sorted = (paths: readonly string[]) =>
  [...paths].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** A FlowSpecSource and a way to make a commit holding given files in a repo it reads. */
export interface FlowSpecSourceHarness {
  readonly layer: Layer.Layer<FlowSpecSource>;
  readonly commit: (
    files: Readonly<Record<string, string>>,
  ) => Effect.Effect<{ readonly repo: RepoRef; readonly base: CommitSha }>;
}

export function describeFlowSpecSourceContract(adapter: string, make: () => FlowSpecSourceHarness) {
  describe(`FlowSpecSource contract: ${adapter}`, () => {
    it.effect("answers the root's paths, and .keel/flow.json and package.json as text", () => {
      const harness = make();
      return Effect.gen(function* () {
        const flow = JSON.stringify({
          flow: { _tag: "step", step: "js-ts.suite" },
          nonce: random(8),
        });
        const { repo, base } = yield* harness.commit({
          "package.json": '{"name":"x"}',
          ".keel/flow.json": flow,
          "src/a.ts": "export const a = 1;\n",
          "README.md": "# x\n",
        });
        const sources = yield* (yield* FlowSpecSource).read(repo, base);
        expect(sorted(sources.rootPaths)).toEqual([".keel", "README.md", "package.json", "src"]);
        expect(sources.flowJson).toBe(flow);
        expect(sources.packageJson).toBe('{"name":"x"}');
      }).pipe(Effect.provide(harness.layer));
    });
    it.effect(
      "reads only the root's package.json and only .keel/flow.json, and leaves out what is missing",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const { repo, base } = yield* harness.commit({
            "pkg/package.json": "{}",
            ".keel/flow.yaml": "flow: {}",
            "nested/.keel/flow.json": "{}",
          });
          const sources = yield* (yield* FlowSpecSource).read(repo, base);
          expect(sorted(sources.rootPaths)).toEqual([".keel", "nested", "pkg"]);
          expect(sources.flowJson).toBeUndefined();
          expect(sources.packageJson).toBeUndefined();
        }).pipe(Effect.provide(harness.layer));
      },
    );
    it.effect("fails ObjectNotFound for a commit the repo does not hold", () => {
      const harness = make();
      return Effect.gen(function* () {
        const { repo } = yield* harness.commit({ "a.txt": "a" });
        const missing = CommitSha.make("f".repeat(40));
        const error = yield* Effect.flip((yield* FlowSpecSource).read(repo, missing));
        expect(error._tag).toBe("ObjectNotFound");
      }).pipe(Effect.provide(harness.layer));
    });
  });
}
