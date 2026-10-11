import { Effect, Option, Result, Schema } from "effect";
import { type CandidateId, ContentHash, NextAction, VerdictId } from "../../domain/kernel/index.ts";
import {
  coerce,
  type FlowPlan,
  type StepReport,
  type StepResult,
  VerdictOutcome,
  type VerificationJob,
  verdict,
} from "../../domain/verification/index.ts";
import {
  BatchVerdicts,
  type CandidateFence,
  EvidenceStore,
  Ids,
  VerifierRuntime,
} from "../ports/index.ts";

/**
 * KeelVerify's use-cases, one per Workflow step: run the job, settle the
 * verdict, record it with the lane. Each is safe to replay: running is the
 * runner's own step, settling is a pure function of the results plus a fresh
 * id kept by its step, and recording is idempotent by instance.
 */

/** The results of every step in the job. An unavailable verifier abstains every step; it never passes one. */
export const runJob = Effect.fn("verification/runJob")(function* (job: VerificationJob) {
  const runtime = yield* VerifierRuntime;
  return yield* runtime.run(job).pipe(
    Effect.catchTag("VerifierUnavailable", () =>
      Effect.succeed(
        job.steps.map((step): StepReport => ({
          stepId: step.id,
          outcome: "abstain",
          failure: "unavailable",
          evidenceClass: step.evidenceCeiling,
          tier: step.tier,
          durationMs: 0,
        })),
      ),
    ),
  );
});

/**
 * A verdict, small enough for a Workflow step's output, with the lines that
 * cite its evidence. A schema, because a next action's args are open: the step
 * persists it as JSON and decodes it on replay.
 */
export const SettledVerdict = Schema.Struct({
  verdictId: VerdictId,
  outcome: VerdictOutcome,
  planHash: ContentHash,
  evidence: Schema.Array(Schema.String),
  failingTests: Schema.Array(Schema.String),
  /** On a bounce, the remedy: fix what failed, push, and submit again. Empty otherwise. */
  nextActions: Schema.Array(NextAction),
});
export type SettledVerdict = typeof SettledVerdict.Type;

/** How many failing tests a verdict cites by name. */
export const CITED_FAILURES = 20;

/** A bounce's remedy, naming the failing tests when the evidence names any. */
const remedy = (cited: readonly string[], more: number): NextAction =>
  cited.length === 0
    ? {
        kind: "call",
        title: "Fix what the verdict's evidence cites, push, then submit again",
        operationId: "submit",
      }
    : {
        kind: "call",
        title: `Fix the failing tests, push, then submit again: ${cited.join("; ")}${
          more > 0 ? ` and ${more} more` : ""
        }`,
        operationId: "submit",
        args: { failingTests: cited },
      };

const StoredFailures = Schema.Struct({
  failing: Schema.Array(
    Schema.Struct({ file: Schema.String, test: Schema.optional(Schema.String) }),
  ),
});

const describe = (r: StepResult): string =>
  `${r.stepId}: ${r.outcome} (${r.evidenceClass}, tier ${r.tier.tier}: ${r.tier.reason})${
    r.resultRef === undefined ? "" : ` evidence ${r.resultRef}`
  }`;

/**
 * Coerces the runner's reports against the plan, takes `verdict/1`, and cites
 * the evidence the outcome rests on: one line per result, then the failing
 * tests by name, read back from the evidence each failing step stored.
 */
export const settleVerdict = Effect.fn("verification/settleVerdict")(function* (
  plan: FlowPlan,
  reports: readonly StepReport[],
) {
  const results = reports.map((r) => coerce(plan, r));
  const decided = verdict(plan, { results }, "verdict/1");
  if (Result.isFailure(decided)) return yield* Effect.die(decided.failure);
  const store = yield* EvidenceStore;
  const failingTests: string[] = [];
  for (const r of decided.success.evidence) {
    const ref = Schema.decodeUnknownOption(ContentHash)(r.resultRef);
    if (r.outcome !== "fail" || Option.isNone(ref)) continue;
    const stored = Schema.decodeUnknownOption(StoredFailures)(
      yield* store.get(ref.value).pipe(Effect.orDie),
    );
    if (Option.isNone(stored)) continue;
    for (const f of stored.value.failing)
      failingTests.push(f.test === undefined ? f.file : `${f.file} > ${f.test}`);
  }
  const cited = failingTests.slice(0, CITED_FAILURES);
  const more = failingTests.length - cited.length;
  const settled: SettledVerdict = {
    verdictId: yield* (yield* Ids).next("vrd"),
    outcome: decided.success.outcome,
    planHash: decided.success.planHash,
    evidence: [
      ...(decided.success.outcome === "land" ? results : decided.success.evidence).map(describe),
      ...cited.map((t) => `failed: ${t}`),
      ...(more > 0 ? [`and ${more} more failing`] : []),
    ],
    failingTests,
    nextActions: decided.success.outcome === "bounce" ? [remedy(cited, more)] : [],
  };
  return settled;
});

/** Reports the verdict to the lane that formed the batch. A fenced result is terminal. */
export const recordBatchVerdict = Effect.fn("verification/recordBatchVerdict")(function* (input: {
  readonly laneId: string;
  readonly instanceId: string;
  readonly fence: CandidateFence;
  readonly candidateId: CandidateId;
  readonly settled: SettledVerdict;
}) {
  const verdicts = yield* BatchVerdicts;
  yield* verdicts.record(input.laneId, {
    instanceId: input.instanceId,
    fence: input.fence,
    candidateId: input.candidateId,
    verdictId: input.settled.verdictId,
    outcome: input.settled.outcome,
    planHash: input.settled.planHash,
    evidence: input.settled.evidence,
    failingTests: input.settled.failingTests,
    ...(input.settled.nextActions.length === 0 ? {} : { nextActions: input.settled.nextActions }),
  });
});
