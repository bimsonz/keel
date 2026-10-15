import { Effect, Option, Result, Schema } from "effect";
import {
  type CandidateId,
  ContentHash,
  InstantSchema,
  NextAction,
  type NamespaceId,
  VerdictId,
} from "../../domain/kernel/index.ts";
import {
  coerce,
  type FlowPlan,
  type HeldDecision,
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
import type { DepsAnswer } from "./deps.ts";
import { citeDiagnostic } from "./typecheck.ts";

/**
 * KeelVerify's use-cases, one per Workflow step: run the job, settle the
 * verdict, record it with the lane. Each is safe to replay: running is the
 * runner's own step, settling is a pure function of the results plus a fresh
 * id kept by its step, and recording is idempotent by instance.
 */

/**
 * The results of every step in the job, each Tier 2 step handed the deps its
 * Workflow ensured. An unavailable verifier abstains every step; it never
 * passes one.
 */
export const runJob = Effect.fn("verification/runJob")(function* (
  namespace: NamespaceId,
  job: VerificationJob,
  deps: DepsAnswer,
) {
  const runtime = yield* VerifierRuntime;
  return yield* runtime.run(namespace, job, deps).pipe(
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
  /** A park that rests only on steps the verifier could not run (`unrunOnly`), or on none run for want of quota. */
  unrun: Schema.optionalKey(Schema.Literal(true)),
  /** On a park for want of quota, when the namespace's limit resets: the lane forms nothing before it. */
  retryAt: Schema.optionalKey(InstantSchema),
  /** A bounce because the namespace's verification spend is stopped: no fault of the change's. */
  halted: Schema.optionalKey(Schema.Literal(true)),
});
export type SettledVerdict = typeof SettledVerdict.Type;

/**
 * Why a verifier could not run a step at all for want of capacity: rate-limited.
 * Not `unavailable`, which a step no runner takes also reports (a fault of
 * Keel's, which must not be requeued for ever), nor a timeout, malformed
 * output or a truncated run, which may be the change's.
 */
const UNRUN: ReadonlySet<string> = new Set(["rate-limited"]);

/**
 * Whether a park rests only on steps the verifier could not run: every
 * escalation is an abstain, and every report of its step failed as `UNRUN`.
 */
const unrunOnly = (
  outcome: SettledVerdict["outcome"],
  evidence: readonly StepResult[],
  reports: readonly StepReport[],
): boolean =>
  outcome === "park" &&
  evidence.length > 0 &&
  evidence.every((r) => {
    const own = reports.filter((report) => report.stepId === r.stepId);
    return (
      r.outcome === "abstain" &&
      own.length > 0 &&
      own.every((report) => report.failure !== undefined && UNRUN.has(report.failure))
    );
  });

/** How many failures (tests, type errors and guards) a verdict cites by name. */
export const CITED_FAILURES = 20;

/**
 * A failure a verdict cites: a failing test, an error the typecheck named, a
 * guard whose probe failed, dependencies that could not be installed or
 * configuration a step needs that the candidate lacks, each with what to do
 * about it, or a deploy check (the build, the preview, or a smoke request) the
 * change failed.
 */
interface Cited {
  readonly kind: "test" | "type" | "guard" | "deps" | "config" | "deploy";
  readonly name: string;
}

export const CITED_AS: Record<Cited["kind"], { readonly plural: string; readonly line: string }> = {
  test: { plural: "failing tests", line: "failed" },
  type: { plural: "type errors", line: "type error" },
  guard: { plural: "guarded behaviour", line: "guard failed" },
  deps: { plural: "dependencies", line: "dependencies refused" },
  config: { plural: "missing configuration", line: "configuration missing" },
  deploy: { plural: "deploy checks", line: "deploy check failed" },
};

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
  const guards = cited.filter((c) => c.kind === "guard").map((c) => c.name);
  const deps = cited.filter((c) => c.kind === "deps").map((c) => c.name);
  const configs = cited.filter((c) => c.kind === "config").map((c) => c.name);
  const deploys = cited.filter((c) => c.kind === "deploy").map((c) => c.name);
  const kinds = (["test", "type", "guard", "deps", "config", "deploy"] as const).filter((k) =>
    cited.some((c) => c.kind === k),
  );
  const phrases = kinds.map((k) => CITED_AS[k].plural);
  const what = `the ${
    phrases.length === 1
      ? (phrases[0] ?? "")
      : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1) ?? ""}`
  }`;
  return {
    kind: "call",
    title: `Fix ${what}, push, then submit again: ${cited.map((c) => c.name).join("; ")}${
      more > 0 ? ` and ${more} more` : ""
    }`,
    operationId: "submit",
    args: {
      ...(tests.length === 0 ? {} : { failingTests: tests }),
      ...(types.length === 0 ? {} : { typeErrors: types }),
      ...(guards.length === 0 ? {} : { failingGuards: guards }),
      ...(deps.length === 0 ? {} : { depsRefused: deps }),
      ...(configs.length === 0 ? {} : { missingConfig: configs }),
      ...(deploys.length === 0 ? {} : { failingDeployChecks: deploys }),
    },
  };
};

/** Where a bounce points for a decision a failing guard holds: the ruling, read whole. */
const readDecision = (decision: HeldDecision): NextAction => ({
  kind: "call",
  title: `Read decision ${decision.id}, which the failed guard holds: ${decision.summary}`,
  operationId: "Memory_getDecision",
  args: { decisionId: decision.id },
});

/**
 * What a failing step stored that names its failures: a suite's tests, a
 * typecheck's errors, a guard's probe, the dependencies it was refused
 * (`depsStop`), the configuration it found missing, or the deploy check it
 * failed.
 */
const StoredFailures = Schema.Struct({
  deploy: Schema.optional(Schema.Struct({ failure: Schema.String })),
  deps: Schema.optional(Schema.Struct({ refused: Schema.String, remedy: Schema.String })),
  config: Schema.optional(Schema.Struct({ missing: Schema.String, remedy: Schema.String })),
  guard: Schema.optional(Schema.Struct({ predicate: Schema.String, probe: Schema.String })),
  reason: Schema.optional(Schema.String),
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
 * tests and type errors by name, and dependencies that were refused with what
 * to do about them, read back from the evidence each failing step stored. `failingTests` names them all, type errors as `file:line:col TScode
 * message`, since the lane attributes a bounce from the first. A fail whose
 * evidence is not stored still stands: the verdict cites `evidence missing`
 * and an ops error is logged, so a lost document never wedges the lane.
 */
export const settleVerdict = Effect.fn("verification/settleVerdict")(function* (
  namespace: NamespaceId,
  plan: FlowPlan,
  reports: readonly StepReport[],
) {
  const results = reports.map((r) => coerce(plan, r));
  const decided = verdict(plan, { results }, "verdict/1");
  if (Result.isFailure(decided)) return yield* Effect.die(decided.failure);
  const store = yield* EvidenceStore;
  const failures: Cited[] = [];
  const missing: string[] = [];
  /** The decisions the failing guards hold, each once: the bounce points to each. */
  const held = new Map<string, HeldDecision>();
  for (const r of decided.success.evidence) {
    const ref = Schema.decodeUnknownOption(ContentHash)(r.resultRef);
    if (r.outcome !== "fail" || Option.isNone(ref)) continue;
    const document = yield* store.get(namespace, ref.value).pipe(
      Effect.map(Option.some),
      Effect.catchTag("EvidenceMissing", () => Effect.succeed(Option.none())),
    );
    if (Option.isNone(document)) {
      missing.push(ref.value);
      yield* Effect.logError(
        `verdict cites evidence that is not stored: ${r.stepId} failed, citing ${ref.value}`,
      );
      continue;
    }
    const stored = Schema.decodeUnknownOption(StoredFailures)(document.value);
    if (Option.isNone(stored)) continue;
    for (const f of stored.value.failing ?? [])
      failures.push({
        kind: "test",
        name: f.test === undefined ? f.file : `${f.file} > ${f.test}`,
      });
    for (const e of stored.value.errors ?? [])
      failures.push({ kind: "type", name: citeDiagnostic(e) });
    // Every step that needed the refused dependencies stored the same refusal: it is cited once.
    const refusal = stored.value.deps;
    const depsName = refusal === undefined ? undefined : `${refusal.refused}: ${refusal.remedy}`;
    if (depsName !== undefined && !failures.some((f) => f.kind === "deps" && f.name === depsName))
      failures.push({ kind: "deps", name: depsName });
    // Missing configuration, too, is cited once however many steps needed it.
    const config = stored.value.config;
    const configName = config === undefined ? undefined : `${config.missing}: ${config.remedy}`;
    if (
      configName !== undefined &&
      !failures.some((f) => f.kind === "config" && f.name === configName)
    )
      failures.push({ kind: "config", name: configName });
    if (stored.value.deploy !== undefined)
      failures.push({ kind: "deploy", name: `${r.stepId}: ${stored.value.deploy.failure}` });
    if (stored.value.guard !== undefined) {
      const decision = plan.steps.find((s) => s.id === r.stepId)?.guards?.decision;
      if (decision !== undefined) held.set(decision.id, decision);
      failures.push({
        kind: "guard",
        name: `${r.stepId} (${stored.value.guard.predicate}): ${stored.value.reason ?? "its probe failed"}${
          decision === undefined ? "" : `; it holds decision ${decision.id}: ${decision.summary}`
        }`,
      });
    }
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
      ...missing.map((ref) => `evidence missing: ${ref}`),
      ...cited.map((c) => `${CITED_AS[c.kind].line}: ${c.name}`),
      ...(more > 0 ? [`and ${more} more failing`] : []),
    ],
    failingTests,
    nextActions:
      decided.success.outcome === "bounce"
        ? [remedy(cited, more), ...[...held.values()].map(readDecision)]
        : [],
    ...(unrunOnly(decided.success.outcome, decided.success.evidence, reports)
      ? { unrun: true }
      : {}),
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
    ...(input.settled.unrun === true ? { unrun: true } : {}),
    ...(input.settled.retryAt === undefined ? {} : { retryAt: input.settled.retryAt }),
    ...(input.settled.halted === true ? { halted: true } : {}),
  });
});
