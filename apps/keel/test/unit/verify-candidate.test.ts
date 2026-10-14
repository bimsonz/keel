import { describe, expect, it } from "@effect/vitest";
import {
  type DepsRefused,
  type DepsUnavailable,
  depsStop,
  recordBatchVerdict,
  runJob,
  settleVerdict,
  WORKER_APP_PACK,
  workerAppDeployPack,
} from "@keeltown/core/application/verification";
import { DeploySpec } from "@keeltown/core/domain/delivery";
import {
  compile,
  type StepReport,
  VerifierUnavailable,
  type VerificationJob,
} from "@keeltown/core/domain/verification";
import { CommitSha, ContentHash, makeId } from "@keeltown/core/kernel";
import { BatchVerdicts, EvidenceStore, VerifierRuntime } from "@keeltown/core/ports";
import {
  freshId,
  makeBatchVerdictsMemory,
  makeEvidenceStoreMemory,
  makeIdsMemory,
  sampleNamespace,
  suitePlan,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";
import { BatchVerdictsRpc } from "../../src/adapters/driven/do-rpc/batch-verdicts.ts";
import { encodeExit } from "../../src/rpc/exit.ts";
import { LaneCodecs, RecordVerdictCommand } from "../../src/rpc/lane.ts";

const SUITE = suitePlan();
const step = SUITE.steps[0];
if (step === undefined) throw new Error("the suite plan has no step");

const batchId = freshId("bat");
const candidateId = freshId("cnd");
const change = freshId("chg");
const fence = { batchId, attempt: 1, chainEpoch: 0 };
const job: VerificationJob = {
  jobId: "job-1",
  bundle: Schema.decodeUnknownSync(ContentHash)(`sha256:${"a".repeat(64)}`),
  steps: SUITE.steps,
  fence,
};

/** A Tier 2 runtime the test scripts: it stores the evidence a real runner would, and answers `outcome`. */
const scriptedRuntime = (outcome: "pass" | "fail" | "unavailable") =>
  Layer.effect(
    VerifierRuntime,
    Effect.gen(function* () {
      const evidence = yield* EvidenceStore;
      return VerifierRuntime.of({
        run: () =>
          outcome === "unavailable"
            ? Effect.fail(new VerifierUnavailable({ reason: "the engine gave up" }))
            : Effect.gen(function* () {
                const resultRef = yield* evidence.put(sampleNamespace, {
                  stepId: step.id,
                  outcome,
                  failing:
                    outcome === "fail"
                      ? [
                          {
                            file: "test/sessions.test.ts",
                            test: "sessions expire",
                            message: "expected 401",
                          },
                          { file: "test/broken.test.ts", message: "failed to run" },
                        ]
                      : [],
                });
                return [
                  {
                    stepId: step.id,
                    outcome,
                    evidenceClass: "proof" as const,
                    tier: step.tier,
                    durationMs: 4321,
                    resultRef,
                  },
                ];
              }),
      });
    }),
  );

const lane = (members = [change]) =>
  makeBatchVerdictsMemory(
    new Map([[batchId, { members, candidateId, attempt: 1, chainEpoch: 0 }]]),
  );

const verify = (
  outcome: "pass" | "fail" | "unavailable",
  l = lane(),
  instanceId = "keel-verify-evt1",
) => {
  const evidence = makeEvidenceStoreMemory().layer;
  const layer = Layer.mergeAll(
    evidence,
    makeIdsMemory().layer,
    l.layer,
    scriptedRuntime(outcome).pipe(Layer.provide(evidence)),
  );
  return Effect.gen(function* () {
    const results = yield* runJob(sampleNamespace, job, { _tag: "DepsUnneeded" });
    const settled = yield* settleVerdict(sampleNamespace, SUITE, results);
    yield* recordBatchVerdict({
      laneId: "lane:prj:default",
      instanceId,
      fence,
      candidateId,
      settled,
    });
    const events = l.outbox.store.rows();
    return { settled, events: [...events.values()] };
  }).pipe(Effect.provide(layer));
};

const types = (l: ReturnType<typeof lane>) =>
  JSON.stringify([...l.outbox.store.rows().values()]).match(
    /"_tag":"(VerdictIssued|BatchVerified|BatchFailed)"/g,
  ) ?? [];

describe("KeelVerify's use-cases", () => {
  it.effect("a green suite lands, and the lane records VerdictIssued with BatchVerified", () => {
    const l = lane();
    return Effect.gen(function* () {
      const { settled } = yield* verify("pass", l);
      expect(settled.outcome).toBe("land");
      expect(settled.planHash).toBe(SUITE.planHash);
      expect(settled.evidence[0]).toMatch(
        /^js-ts\.suite: pass \(proof, tier 2: .*\) evidence sha256:/,
      );
      expect(l.recorded.map((r) => r.verdict.outcome)).toEqual(["land"]);
      expect(types(l)).toEqual(['"_tag":"VerdictIssued"', '"_tag":"BatchVerified"']);
    });
  });

  it.effect(
    "[verify.bounce-cites] a red suite bounces, citing the failing tests by name, and fails the batch on its one change",
    () => {
      const l = lane();
      return Effect.gen(function* () {
        const { settled } = yield* verify("fail", l);
        expect(settled.outcome).toBe("bounce");
        expect(settled.failingTests).toEqual([
          "test/sessions.test.ts > sessions expire",
          "test/broken.test.ts",
        ]);
        expect(settled.evidence).toContain("failed: test/sessions.test.ts > sessions expire");
        expect(settled.evidence).toContain("failed: test/broken.test.ts");
        expect(JSON.stringify([...l.outbox.store.rows().values()])).toContain(
          `"attribution":"${change}"`,
        );
      });
    },
  );

  it.effect(
    "[verify.bounce-remedy] a bounce carries the remedy, naming the failing tests, and the lane receives it; a land carries none",
    () => {
      const red = lane();
      const green = lane();
      return Effect.gen(function* () {
        const { settled } = yield* verify("fail", red);
        expect(settled.nextActions).toEqual([
          {
            kind: "call",
            title:
              "Fix the failing tests, push, then submit again: test/sessions.test.ts > sessions expire; test/broken.test.ts",
            operationId: "submit",
            args: {
              failingTests: ["test/sessions.test.ts > sessions expire", "test/broken.test.ts"],
            },
          },
        ]);
        expect(red.recorded.map((r) => r.verdict.nextActions)).toEqual([settled.nextActions]);
        const landed = yield* verify("pass", green);
        expect(landed.settled.nextActions).toEqual([]);
        expect(green.recorded.map((r) => r.verdict.nextActions)).toEqual([undefined]);
      });
    },
  );

  it.effect(
    "[verify.remedy-over-rpc] the Lane's recordVerdict receives the remedy in its command",
    () => {
      const sent: unknown[] = [];
      const lanes = {
        idFromName: (name: string): DurableObjectId => ({
          name,
          toString: () => name,
          equals: (other) => other.toString() === name,
        }),
        get: () => ({
          recordVerdict: async (command: unknown) => {
            sent.push(command);
            return encodeExit(LaneCodecs.recordVerdict, Exit.void);
          },
        }),
      };
      const nextActions = [
        {
          kind: "call" as const,
          title: "Fix the failing tests",
          operationId: "submit",
          args: { failingTests: ["t"] },
        },
      ];
      return Effect.gen(function* () {
        yield* (yield* BatchVerdicts).record("lane:prj:default", {
          instanceId: "keel-verify-evt9",
          fence,
          candidateId,
          verdictId: makeId("vrd", "01JZD9D9D9D9D9D9D9D9D9D9D9"),
          outcome: "bounce",
          planHash: SUITE.planHash,
          evidence: ["js-ts.suite: fail"],
          failingTests: ["t"],
          nextActions,
        });
        const [command] = sent.map((c) => Schema.decodeUnknownSync(RecordVerdictCommand)(c));
        expect(command?.nextActions).toEqual(nextActions);
      }).pipe(Effect.provide(BatchVerdictsRpc(lanes)));
    },
  );

  it.effect("a failure in a batch of several is unattributed until bisection", () => {
    const l = lane([change, freshId("chg")]);
    return Effect.gen(function* () {
      yield* verify("fail", l);
      expect(JSON.stringify([...l.outbox.store.rows().values()])).toContain(
        '"attribution":"unattributed"',
      );
    });
  });

  it.effect(
    "[verify.unavailable-parks] an unavailable verifier parks the batch as infra, never landing it",
    () => {
      const l = lane();
      return Effect.gen(function* () {
        const { settled } = yield* verify("unavailable", l);
        expect(settled.outcome).toBe("park");
        expect(JSON.stringify([...l.outbox.store.rows().values()])).toContain(
          '"attribution":"infra"',
        );
      });
    },
  );

  it.effect("a replayed record step commits nothing new", () => {
    const l = lane();
    return Effect.gen(function* () {
      yield* verify("pass", l, "keel-verify-evt7");
      yield* verify("pass", l, "keel-verify-evt7");
      expect(types(l)).toHaveLength(2);
    });
  });

  it.effect("a result for a stale attempt is fenced", () => {
    const l = makeBatchVerdictsMemory(
      new Map([[batchId, { members: [change], candidateId, attempt: 2, chainEpoch: 0 }]]),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(verify("pass", l));
      expect(error._tag).toBe("ResultFenced");
      expect(types(l)).toHaveLength(0);
    });
  });
});

describe("a worker app's verdict", () => {
  const compiled = compile(
    undefined,
    { baseCommit: CommitSha.make("0".repeat(40)), touchedPaths: [], subjects: [], facts: {} },
    WORKER_APP_PACK,
  );
  if (compiled._tag === "Failure") throw new Error("the worker-app pack does not compile");
  const plan = compiled.success;
  const ERRORS = [
    {
      file: "src/clock.ts",
      line: 12,
      column: 14,
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
    },
    { code: "TS5058", message: "The specified path does not exist: 'tsconfig.json'." },
  ];

  /** Settles the plan on a suite and a typecheck outcome, storing what each step would. */
  const settle = (suite: "pass" | "fail", typecheck: "pass" | "fail") => {
    const store = makeEvidenceStoreMemory();
    return Effect.gen(function* () {
      const evidence = yield* EvidenceStore;
      const reports: StepReport[] = [];
      for (const s of plan.steps) {
        const outcome = s.id === "js-ts.suite" ? suite : typecheck;
        const stored =
          s.id === "js-ts.suite"
            ? {
                failing:
                  outcome === "fail" ? [{ file: "test/sessions.test.ts", test: "expire" }] : [],
              }
            : { errors: outcome === "fail" ? ERRORS : [] };
        const resultRef = yield* evidence.put(sampleNamespace, {
          stepId: s.id,
          outcome,
          ...stored,
        });
        reports.push({
          stepId: s.id,
          outcome,
          evidenceClass: s.evidenceCeiling,
          tier: s.tier,
          durationMs: 1,
          resultRef,
        });
      }
      return yield* settleVerdict(sampleNamespace, plan, reports);
    }).pipe(Effect.provide(Layer.merge(store.layer, makeIdsMemory().layer)));
  };

  /** Settles the plan with every step handed these deps, each storing what a step handed no bundle stores. */
  const settleStopped = (deps: DepsUnavailable | DepsRefused) => {
    const store = makeEvidenceStoreMemory();
    return Effect.gen(function* () {
      const evidence = yield* EvidenceStore;
      const reports: StepReport[] = [];
      for (const s of plan.steps) {
        const stop = depsStop(s, deps);
        const resultRef = yield* evidence.put(sampleNamespace, { ...stop.evidence });
        reports.push({ ...stop.report, resultRef });
      }
      return yield* settleVerdict(sampleNamespace, plan, reports);
    }).pipe(Effect.provide(Layer.merge(store.layer, makeIdsMemory().layer)));
  };

  it.effect(
    "[verify.deps-refused-cited] refused dependencies bounce on the first round, cited once with what to do however many steps stored the refusal",
    () =>
      Effect.gen(function* () {
        expect(plan.steps.map((s) => s.tier.tier)).toEqual([2, 2]);
        const settled = yield* settleStopped({
          _tag: "DepsRefused",
          reason: "install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE",
        });
        const cited =
          "install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE: the installer refused the lockfile (ERR_PNPM_OUTDATED_LOCKFILE): run pnpm install and commit the pnpm-lock.yaml it writes";
        expect(settled.outcome).toBe("bounce");
        expect(settled.failingTests).toEqual([cited]);
        expect(settled.evidence.filter((line) => line.includes("refused"))).toEqual([
          `dependencies refused: ${cited}`,
        ]);
        expect(settled.nextActions).toEqual([
          {
            kind: "call",
            title: `Fix the dependencies, push, then submit again: ${cited}`,
            operationId: "submit",
            args: { depsRefused: [cited] },
          },
        ]);
      }),
  );

  it.effect(
    "[verify.deps-unavailable-uncited] unavailable dependencies never bounce: the verdict cites no failure and asks nothing of the agent",
    () =>
      Effect.gen(function* () {
        const settled = yield* settleStopped({ _tag: "DepsUnavailable", reason: "upload-failed" });
        expect(settled.outcome).toBe("park");
        expect(settled.failingTests).toEqual([]);
        expect(settled.evidence.filter((line) => line.includes("refused"))).toEqual([]);
        expect(settled.nextActions).toEqual([]);
      }),
  );

  it.effect(
    "[verify.type-errors-cited] a failing typecheck bounces, citing each type error in the evidence, failingTests and the remedy",
    () =>
      Effect.gen(function* () {
        const settled = yield* settle("pass", "fail");
        const cited = [
          "src/clock.ts:12:14 TS2322 Type 'string' is not assignable to type 'number'.",
          "TS5058 The specified path does not exist: 'tsconfig.json'.",
        ];
        expect(settled.outcome).toBe("bounce");
        expect(settled.failingTests).toEqual(cited);
        expect(settled.evidence).toEqual(
          expect.arrayContaining(cited.map((c) => `type error: ${c}`)),
        );
        expect(settled.nextActions).toEqual([
          {
            kind: "call",
            title: `Fix the type errors, push, then submit again: ${cited.join("; ")}`,
            operationId: "submit",
            args: { typeErrors: cited },
          },
        ]);
      }),
  );

  it.effect("a bounce on both names the failing tests and the type errors", () =>
    Effect.gen(function* () {
      const settled = yield* settle("fail", "fail");
      const [remedy] = settled.nextActions;
      expect(remedy?.title).toMatch(/^Fix the failing tests and type errors, push/);
      expect(remedy?.args).toEqual({
        failingTests: ["test/sessions.test.ts > expire"],
        typeErrors: [
          "src/clock.ts:12:14 TS2322 Type 'string' is not assignable to type 'number'.",
          "TS5058 The specified path does not exist: 'tsconfig.json'.",
        ],
      });
      expect((yield* settle("pass", "pass")).outcome).toBe("land");
    }),
  );
});

describe("a deployed worker app's verdict", () => {
  const plan = compile(
    undefined,
    { baseCommit: CommitSha.make("0".repeat(40)), touchedPaths: [], subjects: [], facts: {} },
    workerAppDeployPack(
      Schema.decodeUnknownSync(DeploySpec)({
        target: "production",
        worker: "worker-lite",
        smoke: [{ path: "/health", status: 200 }],
      }),
    ),
  );
  if (plan._tag === "Failure") throw new Error("the deploy pack does not compile");

  it.effect(
    "[verify.deploy-cited] a failed deploy check bounces, cited by its step and what failed, and the bounce asks for it to be fixed",
    () =>
      Effect.gen(function* () {
        const evidence = yield* EvidenceStore;
        const failure = "GET /health answered 500, not 200";
        const reports: StepReport[] = [];
        for (const s of plan.success.steps) {
          const outcome = s.id === "deploy.smoke" ? "fail" : "pass";
          const resultRef = yield* evidence.put(sampleNamespace, {
            stepId: s.id,
            outcome,
            ...(outcome === "fail" ? { deploy: { failure } } : {}),
          });
          reports.push({
            stepId: s.id,
            outcome,
            evidenceClass: s.evidenceCeiling,
            tier: s.tier,
            durationMs: 1,
            resultRef,
          });
        }
        const settled = yield* settleVerdict(sampleNamespace, plan.success, reports);
        const cited = `deploy.smoke: ${failure}`;
        expect(settled.outcome).toBe("bounce");
        expect(settled.failingTests).toEqual([cited]);
        expect(settled.evidence.filter((line) => line.startsWith("deploy check"))).toEqual([
          `deploy check failed: ${cited}`,
        ]);
        expect(settled.nextActions).toEqual([
          {
            kind: "call",
            title: `Fix the deploy checks, push, then submit again: ${cited}`,
            operationId: "submit",
            args: { failingDeployChecks: [cited] },
          },
        ]);
      }).pipe(Effect.provide(Layer.merge(makeEvidenceStoreMemory().layer, makeIdsMemory().layer))),
  );
});
