import { describe, expect, it } from "@effect/vitest";
import { L1_SUITE_PLAN } from "@keeltown/core/application/verification";
import { canBlock, ContentHash, contentHashOf, makeId, weakest } from "@keeltown/core/kernel";
import type { PlanStep, VerificationJob } from "@keeltown/core/domain/verification";
import {
  type BatchVerdict,
  BatchVerdicts,
  BundleStore,
  EvidenceStore,
  VerifierRuntime,
} from "@keeltown/core/ports";
import { Effect, type Layer, Schema } from "effect";
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

const probeStep: PlanStep = {
  id: "contract.probe",
  kind: "probe",
  evidenceCeiling: "proof",
  appliesTo: [],
  tier: { tier: 1, reason: "a probe runs in an isolate" },
  because: "the contract",
  outcomes: ["pass", "fail", "abstain"],
};

/** A job with the L1 suite and a probe: every adapter answers each step, whatever it can run. */
export const contractJob = (): VerificationJob => ({
  jobId: `job-${random(6)}`,
  bundle: Schema.decodeUnknownSync(ContentHash)(`sha256:${random(32)}`),
  steps: [...L1_SUITE_PLAN.steps, probeStep],
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
  planHash: L1_SUITE_PLAN.planHash,
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
export const freshId = <P extends "bat" | "cnd" | "chg">(prefix: P) => makeId(prefix, ulid());
