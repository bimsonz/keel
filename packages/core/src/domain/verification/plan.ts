import { Schema } from "effect";
import { Predicate } from "../coordination/index.ts";
import { PredicatePolicy, ContentHash, EvidenceClass, Glob, TierChoice } from "../kernel/index.ts";

export const StepKind = Schema.Literals([
  "deterministic",
  "decision-model",
  "generative",
  "probe",
  "human",
  "deploy",
]);
export type StepKind = typeof StepKind.Type;

/** Every step can abstain; only proof and rulings may fail (ADR 0005). */
export const StepOutcome = Schema.Literals(["pass", "fail", "escalate", "annotate", "abstain"]);
export type StepOutcome = typeof StepOutcome.Type;

/** A project's flow spec and plugin hashes, as read from the base commit. */
export const FlowSpec = Schema.Struct({
  source: Schema.String,
  hash: ContentHash,
  plugins: Schema.Array(ContentHash),
});
export type FlowSpec = typeof FlowSpec.Type;

export const PlanStep = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: StepKind,
  evidenceCeiling: EvidenceClass,
  appliesTo: Schema.Array(Glob),
  tier: TierChoice,
  /** Why this step exists for this change: the premise, effect or rule that put it here. */
  because: Schema.String,
  /** The class this step's evidence actually carries after taint: the weakest it consumed. */
  effectiveClass: Schema.optional(EvidenceClass),
  /** The outcomes the step declares; `abstain` is always among them. */
  outcomes: Schema.optional(Schema.Array(StepOutcome)),
  /** The project marked this step optional, so an opinion step may skip it. */
  optional: Schema.optional(Schema.Boolean),
  /** The worlds the step runs in, for world-matrix steps. */
  worlds: Schema.optional(Schema.Array(Schema.Literals(["trunk", "A", "B", "AB"]))),
  /**
   * Set when the step is a guard of a tenet on `predicate`: its proof fail
   * takes the project's policy for that predicate, resolved at compile
   * (absent there is `advise`). Only under `block` does it fail the verdict.
   * `probe` is the admitted probe bundle the step runs, pinned under the plan
   * hash: the verifier fetches it from the guard store by this hash, never
   * from the candidate's `.keel/guards/`.
   */
  guards: Schema.optional(
    Schema.Struct({ predicate: Predicate, policy: PredicatePolicy, probe: ContentHash }),
  ),
});
export type PlanStep = typeof PlanStep.Type;

/** The throwaway pipeline compiled for one change. Content-addressed by `planHash`. */
export const VerificationPlan = Schema.Struct({
  planHash: ContentHash,
  steps: Schema.Array(PlanStep),
  costEstimate: Schema.Finite,
  /** The compiled flow tree the steps came from. Opaque outside the flow compiler. */
  flow: Schema.optional(Schema.Unknown),
});
export type VerificationPlan = typeof VerificationPlan.Type;

/** One unit of execution handed to a verifier: a bundle and the steps to run on it. */
export const VerificationJob = Schema.Struct({
  jobId: Schema.NonEmptyString,
  bundle: ContentHash,
  steps: Schema.Array(PlanStep),
  fence: Schema.Struct({ batchId: Schema.String, attempt: Schema.Int, chainEpoch: Schema.Int }),
});
export type VerificationJob = typeof VerificationJob.Type;

export const StepResult = Schema.Struct({
  stepId: Schema.NonEmptyString,
  outcome: StepOutcome,
  evidenceClass: EvidenceClass,
  tier: TierChoice,
  durationMs: Schema.Finite,
  resultRef: Schema.optional(Schema.String),
  world: Schema.optional(Schema.Literals(["trunk", "A", "B", "AB"])),
  /** Steps this step's outcome skipped (an opinion step may skip only optional ones). */
  skips: Schema.optional(Schema.Array(Schema.String)),
  /** Failures this step overrode; only a human decision may override a fail. */
  overrides: Schema.optional(Schema.Array(Schema.String)),
});
export type StepResult = typeof StepResult.Type;

export const VerdictOutcome = Schema.Literals(["land", "bounce", "park", "hold", "supersede"]);
export type VerdictOutcome = typeof VerdictOutcome.Type;
