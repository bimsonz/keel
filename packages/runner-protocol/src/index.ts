import { Schema } from "effect";

/**
 * Runner protocol v0: the messages between Keel's control plane and whatever
 * executes verification steps (a VerifierDO and its isolates, a container
 * runner, MergeBox). Unpublished wire, so it is Effect Schema, versioned in
 * every message. Bundles are content-addressed; runners hold no credentials.
 */
export const PROTOCOL_VERSION = "keel-runner/0" as const;

const Version = Schema.Literal(PROTOCOL_VERSION);
const Hash = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/));
const Tier = Schema.Literals([0, 1, 2]);

/** Late results are fenced on (batchId, attempt, chainEpoch): a stale attempt's answer is dropped. */
export const Fence = Schema.Struct({
  batchId: Schema.String,
  attempt: Schema.Int,
  chainEpoch: Schema.Int,
});
export type Fence = typeof Fence.Type;

export const Budget = Schema.Struct({
  cpuMs: Schema.Int,
  wallMs: Schema.Int,
  subrequests: Schema.Int,
  tokens: Schema.optional(Schema.Int),
  usd: Schema.optional(Schema.Number),
});
export type Budget = typeof Budget.Type;

export const StepSpec = Schema.Struct({
  stepId: Schema.NonEmptyString,
  kind: Schema.Literals([
    "deterministic",
    "decision-model",
    "generative",
    "probe",
    "human",
    "deploy",
  ]),
  /** The plugin or tool to run, by content hash. */
  runs: Hash,
  world: Schema.optional(Schema.Literals(["trunk", "A", "B", "AB"])),
  tier: Tier,
  tierReason: Schema.NonEmptyString,
  outcomes: Schema.Array(Schema.String),
});
export type StepSpec = typeof StepSpec.Type;

export const JobSubmitted = Schema.TaggedStruct("JobSubmitted", {
  protocol: Version,
  jobId: Schema.NonEmptyString,
  attempt: Schema.Int,
  fence: Fence,
  bundle: Schema.Struct({ hash: Hash, r2Key: Schema.NonEmptyString }),
  steps: Schema.NonEmptyArray(StepSpec),
  budget: Budget,
});

export const StepStarted = Schema.TaggedStruct("StepStarted", {
  protocol: Version,
  jobId: Schema.NonEmptyString,
  fence: Fence,
  stepId: Schema.NonEmptyString,
  tier: Tier,
});

/** Logs are redacted and written to R2; the message carries only where. */
export const StepLogChunk = Schema.TaggedStruct("StepLogChunk", {
  protocol: Version,
  jobId: Schema.NonEmptyString,
  stepId: Schema.NonEmptyString,
  seq: Schema.Int,
  r2Key: Schema.NonEmptyString,
});

/**
 * Every step ends in an outcome, `abstain` included: timeouts, 429s, schema
 * failures and truncation abstain rather than pass or fail.
 */
export const StepFinished = Schema.TaggedStruct("StepFinished", {
  protocol: Version,
  jobId: Schema.NonEmptyString,
  fence: Fence,
  stepId: Schema.NonEmptyString,
  outcome: Schema.Literals(["pass", "fail", "escalate", "annotate", "abstain"]),
  evidenceClass: Schema.Literals(["proof", "ruling", "testimony", "opinion"]),
  tier: Tier,
  tierReason: Schema.NonEmptyString,
  durationMs: Schema.Number,
  /** Results over 1 MiB live in R2. */
  resultRef: Schema.optional(Schema.String),
});

export const JobFinished = Schema.TaggedStruct("JobFinished", {
  protocol: Version,
  jobId: Schema.NonEmptyString,
  fence: Fence,
  outcome: Schema.Literals(["completed", "infra-failure", "budget-exhausted"]),
});

export const JobCancelled = Schema.TaggedStruct("JobCancelled", {
  protocol: Version,
  jobId: Schema.NonEmptyString,
  fence: Fence,
  reason: Schema.String,
});

/** A step the tier cannot run (exit 127, a missing toolchain) asks to move up a tier. Escalations stay escalated. */
export const EscalationRequested = Schema.TaggedStruct("EscalationRequested", {
  protocol: Version,
  jobId: Schema.NonEmptyString,
  fence: Fence,
  stepId: Schema.NonEmptyString,
  from: Tier,
  to: Tier,
  reason: Schema.NonEmptyString,
});

/** Control plane → runner. */
export const ToRunner = Schema.Union([JobSubmitted, JobCancelled]);
export type ToRunner = typeof ToRunner.Type;

/** Runner → control plane. */
export const FromRunner = Schema.Union([
  StepStarted,
  StepLogChunk,
  StepFinished,
  JobFinished,
  EscalationRequested,
]);
export type FromRunner = typeof FromRunner.Type;

export const RunnerMessage = Schema.Union([ToRunner, FromRunner]);
export type RunnerMessage = typeof RunnerMessage.Type;
