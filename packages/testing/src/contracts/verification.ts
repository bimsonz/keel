import { describe, expect, it } from "@effect/vitest";
import {
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
        const hash = yield* store.put(bytes);
        expect(hash).toBe(yield* Effect.promise(() => sha256(bytes)));
        expect(yield* store.put(bytes)).toBe(hash);
        expect([...(yield* store.get(hash))]).toEqual([...bytes]);
      }).pipe(Effect.provide(make())),
    );
    it.effect("fails BundleMissing for a hash it never stored", () =>
      Effect.gen(function* () {
        const store = yield* BundleStore;
        const missing = Schema.decodeUnknownSync(ContentHash)(`sha256:${random(32)}`);
        const error = yield* Effect.flip(store.get(missing));
        expect(error._tag).toBe("BundleMissing");
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
          const hash = yield* store.put(document);
          expect(hash).toBe(contentHashOf(document));
          expect(
            yield* store.put({
              failing: document.failing,
              nonce: document.nonce,
              stepId: "js-ts.suite",
            }),
          ).toBe(hash);
          expect(yield* store.get(hash)).toEqual(document);
        }).pipe(Effect.provide(make())),
    );
    it.effect("fails EvidenceMissing for a hash it never stored", () =>
      Effect.gen(function* () {
        const store = yield* EvidenceStore;
        const missing = Schema.decodeUnknownSync(ContentHash)(`sha256:${random(32)}`);
        const error = yield* Effect.flip(store.get(missing));
        expect(error._tag).toBe("EvidenceMissing");
      }).pipe(Effect.provide(make())),
    );
  });
}

export interface PlanStoreHarness {
  readonly layer: Layer.Layer<PlanStore>;
  /** Files raw text under a plan hash, as storage at rest might hold it. */
  readonly plant: (hash: ContentHash, text: string) => Effect.Effect<void>;
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
          expect(yield* store.put(plan)).toBe(plan.planHash);
          expect(yield* store.put(plan)).toBe(plan.planHash);
          expect(yield* store.get(plan.planHash)).toEqual(plan);
        }).pipe(Effect.provide(harness.layer));
      },
    );
    it.effect("[plan-store.missing] fails PlanMissing for a hash it never stored", () => {
      const harness = make();
      return Effect.gen(function* () {
        const missing = Schema.decodeUnknownSync(ContentHash)(`sha256:${random(32)}`);
        const error = yield* Effect.flip((yield* PlanStore).get(missing));
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
          yield* harness.plant(plan.planHash, JSON.stringify(edited));
          const error = yield* Effect.flip((yield* PlanStore).get(plan.planHash));
          expect(error).toMatchObject({ _tag: "PlanCorrupt", hash: plan.planHash });
          const dropped = { ...JSON.parse(textOf(plan)), steps: [] };
          yield* harness.plant(plan.planHash, JSON.stringify(dropped));
          expect((yield* Effect.flip((yield* PlanStore).get(plan.planHash)))._tag).toBe(
            "PlanCorrupt",
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );
    it.effect("[plan-store.keyed] refuses a genuine plan filed under another plan's hash", () => {
      const harness = make();
      return Effect.gen(function* () {
        const [wanted, other] = [freshPlan(), freshPlan()];
        yield* harness.plant(wanted.planHash, textOf(other));
        const error = yield* Effect.flip((yield* PlanStore).get(wanted.planHash));
        expect(error).toMatchObject({ _tag: "PlanCorrupt", hash: wanted.planHash });
      }).pipe(Effect.provide(harness.layer));
    });
    it.effect("refuses text that is not a plan", () => {
      const harness = make();
      return Effect.gen(function* () {
        const store = yield* PlanStore;
        for (const text of ["not json", "{}", JSON.stringify({ planHash: "sha256:x" })]) {
          const hash = Schema.decodeUnknownSync(ContentHash)(`sha256:${random(32)}`);
          yield* harness.plant(hash, text);
          expect((yield* Effect.flip(store.get(hash)))._tag).toBe("PlanCorrupt");
        }
      }).pipe(Effect.provide(harness.layer));
    });
    it.effect("[plan-store.refuses-lying-plan] never stores a plan whose own hash lies", () => {
      const harness = make();
      return Effect.gen(function* () {
        const store = yield* PlanStore;
        const plan = freshPlan();
        const lying = { ...plan, humanClass: !plan.humanClass };
        expect(Exit.isFailure(yield* Effect.exit(store.put(lying)))).toBe(true);
        expect((yield* Effect.flip(store.get(plan.planHash)))._tag).toBe("PlanMissing");
      }).pipe(Effect.provide(harness.layer));
    });
  });
}

export interface ProbeStoreHarness {
  readonly layer: Layer.Layer<ProbeStore>;
  /** The files stored under a hash, as a VerifierDO would read them back; none when nothing is. */
  readonly read: (hash: ContentHash) => Effect.Effect<readonly ProbeFile[] | undefined>;
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
          const hash = yield* (yield* ProbeStore).put(put);
          expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
          const read = yield* harness.read(hash);
          expect(read === undefined ? undefined : byPath(read)).toEqual(byPath(put));
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
          const hash = yield* store.put(probeFiles(marker));
          expect(yield* store.put(probeFiles(marker).toReversed())).toBe(hash);
          expect(yield* store.put(probeFiles(`${marker}!`))).not.toBe(hash);
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
          const results = yield* runtime.run(job);
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
  });
}

/** A fresh id for harnesses to seed batches and candidates with. */
export const freshId = <P extends "bat" | "cnd" | "chg" | "prj">(prefix: P) =>
  makeId(prefix, ulid());

export interface ChangePrecheckHarness {
  readonly layer: Layer.Layer<ChangePrecheck>;
  /** A change just submitted: its id, its revision, and the workspace it holds. */
  readonly submitted: () => Effect.Effect<{
    readonly changeId: ReturnType<typeof freshId<"chg">>;
    readonly revision: number;
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
          yield* Effect.flip(changes.started(unknown, call)),
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
          const { changeId, revision } = yield* h.submitted();
          const instanceId = `precheck-${random(6)}`;
          const stale = yield* Effect.flip(
            changes.started(changeId, { revision: revision + 1, instanceId }),
          );
          expect(stale._tag).toBe("ChangeStateRefused");
          // Still submitted: the current revision starts.
          yield* changes.started(changeId, { revision, instanceId });
        }).pipe(Effect.provide(h.layer));
      },
    );

    it.effect(
      "takes a submission to its plan once: a replayed step commits nothing new, another instance is refused",
      () => {
        const h = harness();
        return Effect.gen(function* () {
          const changes = yield* ChangePrecheck;
          const { changeId, revision } = yield* h.submitted();
          const call = { revision, instanceId: `precheck-${random(6)}` };
          yield* changes.started(changeId, call);
          yield* changes.started(changeId, call);
          yield* changes.compiled(changeId, { ...call, ...PLAN });
          yield* changes.compiled(changeId, { ...call, ...PLAN });
          const other = { revision, instanceId: `precheck-${random(6)}` };
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
          const { changeId, revision } = yield* h.submitted();
          const call = { revision, instanceId: `precheck-${random(6)}` };
          yield* changes.started(changeId, call);
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
          const { changeId, revision } = yield* h.submitted();
          const call = { revision, instanceId: `precheck-${random(6)}` };
          const tagOf = (derived: PrecheckCall) =>
            Effect.map(
              Effect.flip(changes.derived(changeId, { ...derived, ...DERIVATION })),
              (refusal) => refusal._tag,
            );
          const early = yield* tagOf({ revision, instanceId: `precheck-${random(6)}` });
          yield* changes.started(changeId, call);
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
          const { changeId, revision } = yield* h.submitted();
          const call = { revision, instanceId: `precheck-${random(6)}` };
          yield* changes.started(changeId, call);
          const verdictId = yield* changes.refused(changeId, { ...call, ...REFUSAL });
          expect(verdictId).toMatch(/^vrd_/);
          expect(yield* changes.refused(changeId, { ...call, ...REFUSAL })).toBe(verdictId);
          expect((yield* Effect.flip(changes.compiled(changeId, { ...call, ...PLAN })))._tag).toBe(
            "ChangeStateRefused",
          );
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
