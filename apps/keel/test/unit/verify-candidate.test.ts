import { describe, expect, it } from "@effect/vitest";
import {
  L1_SUITE_PLAN,
  recordBatchVerdict,
  runJob,
  settleVerdict,
} from "@keeltown/core/application/verification";
import { VerifierUnavailable, type VerificationJob } from "@keeltown/core/domain/verification";
import { ContentHash, makeId } from "@keeltown/core/kernel";
import { BatchVerdicts, EvidenceStore, VerifierRuntime } from "@keeltown/core/ports";
import {
  freshId,
  makeBatchVerdictsMemory,
  makeEvidenceStoreMemory,
  makeIdsMemory,
} from "@keeltown/testing";
import { Effect, Exit, Layer, Schema } from "effect";
import { BatchVerdictsRpc } from "../../src/adapters/driven/do-rpc/batch-verdicts.ts";
import { encodeExit } from "../../src/rpc/exit.ts";
import { LaneCodecs, RecordVerdictCommand } from "../../src/rpc/lane.ts";

const step = L1_SUITE_PLAN.steps[0];
if (step === undefined) throw new Error("the L1 plan has no step");

const batchId = freshId("bat");
const candidateId = freshId("cnd");
const change = freshId("chg");
const fence = { batchId, attempt: 1, chainEpoch: 0 };
const job: VerificationJob = {
  jobId: "job-1",
  bundle: Schema.decodeUnknownSync(ContentHash)(`sha256:${"a".repeat(64)}`),
  steps: L1_SUITE_PLAN.steps,
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
                const resultRef = yield* evidence.put({
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
    const results = yield* runJob(job);
    const settled = yield* settleVerdict(L1_SUITE_PLAN, results);
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
      expect(settled.planHash).toBe(L1_SUITE_PLAN.planHash);
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
          planHash: L1_SUITE_PLAN.planHash,
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
