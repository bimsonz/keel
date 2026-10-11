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
import { citeDiagnostic } from "./typecheck.ts";

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

/** How many failures (tests and type errors) a verdict cites by name. */
export const CITED_FAILURES = 20;

/** A failure a verdict cites: a failing test, or an error the typecheck named. */
interface Cited {
  readonly kind: "test" | "type";
  readonly name: string;
}

/** A bounce's remedy, naming what failed when the evidence names anything. */
const remedy = (cited: readonly Cited[], more: number): NextAction => {
  if (cited.length === 0)
    return {
      kind: "call",
      title: "Fix what the verdict's evidence cites, push, then submit again",
      operationId: "submit",
    };
  const tests = cited.filter((c) => c.kind === "test").map((c) => c.name);
  const types = cited.filter((c) => c.kind === "type").map((c) => c.name);
  const what =
    types.length === 0
      ? "the failing tests"
      : tests.length === 0
        ? "the type errors"
        : "the failing tests and type errors";
  return {
    kind: "call",
    title: `Fix ${what}, push, then submit again: ${cited.map((c) => c.name).join("; ")}${
      more > 0 ? ` and ${more} more` : ""
    }`,
    operationId: "submit",
    args: {
      ...(tests.length === 0 ? {} : { failingTests: tests }),
      ...(types.length === 0 ? {} : { typeErrors: types }),
    },
  };
};

/** What a failing step stored that names its failures: a suite's tests, a typecheck's errors. */
const StoredFailures = Schema.Struct({
  failing: Schema.optional(
    Schema.Array(Schema.Struct({ file: Schema.String, test: Schema.optional(Schema.String) })),
  ),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        file: Schema.optionalKey(Schema.String),
        line: Schema.optionalKey(Schema.Number),
        column: Schema.optionalKey(Schema.Number),
        code: Schema.String,
        message: Schema.String,
      }),
    ),
  ),
});

const describe = (r: StepResult): string =>
  `${r.stepId}: ${r.outcome} (${r.evidenceClass}, tier ${r.tier.tier}: ${r.tier.reason})${
    r.resultRef === undefined ? "" : ` evidence ${r.resultRef}`
  }`;

/**
 * Coerces the runner's reports against the plan, takes `verdict/1`, and cites
 * the evidence the outcome rests on: one line per result, then the failing
 * tests and type errors by name, read back from the evidence each failing step
 * stored. `failingTests` names them all, type errors as `file:line:col TScode
 * message`, since the lane attributes a bounce from the first.
 */
export const settleVerdict = Effect.fn("verification/settleVerdict")(function* (
  plan: FlowPlan,
  reports: readonly StepReport[],
) {
  const results = reports.map((r) => coerce(plan, r));
  const decided = verdict(plan, { results }, "verdict/1");
  if (Result.isFailure(decided)) return yield* Effect.die(decided.failure);
  const store = yield* EvidenceStore;
  const failures: Cited[] = [];
  for (const r of decided.success.evidence) {
    const ref = Schema.decodeUnknownOption(ContentHash)(r.resultRef);
    if (r.outcome !== "fail" || Option.isNone(ref)) continue;
    const stored = Schema.decodeUnknownOption(StoredFailures)(
      yield* store.get(ref.value).pipe(Effect.orDie),
    );
    if (Option.isNone(stored)) continue;
    for (const f of stored.value.failing ?? [])
      failures.push({
        kind: "test",
        name: f.test === undefined ? f.file : `${f.file} > ${f.test}`,
      });
    for (const e of stored.value.errors ?? [])
      failures.push({ kind: "type", name: citeDiagnostic(e) });
  }
  const failingTests = failures.map((f) => f.name);
  const cited = failures.slice(0, CITED_FAILURES);
  const more = failures.length - cited.length;
  const settled: SettledVerdict = {
    verdictId: yield* (yield* Ids).next("vrd"),
    outcome: decided.success.outcome,
    planHash: decided.success.planHash,
    evidence: [
      ...(decided.success.outcome === "land" ? results : decided.success.evidence).map(describe),
      ...cited.map((c) => `${c.kind === "test" ? "failed" : "type error"}: ${c.name}`),
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
