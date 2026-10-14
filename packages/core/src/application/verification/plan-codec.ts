import { Result, Schema } from "effect";
import { SubjectKey } from "../../domain/coordination/index.ts";
import { CommitSha, ContentHash, EvidenceClass, Glob, Tier } from "../../domain/kernel/index.ts";
import {
  type Budget,
  type Condition,
  type Flow,
  type FlowPlan,
  FlowWorld,
  PlanStep,
  planHashOf,
  type Read,
  StepKind,
  StepOutcome,
  type StepSpec,
} from "../../domain/verification/index.ts";

/**
 * JSON codecs for the flow grammar's types, which the domain declares as
 * plain types: what `.keel/flow.json` holds and what the plan store keeps.
 * Each is typed against the domain's own type, so the two cannot drift.
 */

export const BudgetJson: Schema.Codec<Budget> = Schema.Struct({
  usd: Schema.Finite,
  cpuMs: Schema.Finite,
  tokens: Schema.Finite,
});

export const ConditionJson: Schema.Codec<Condition> = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("outcome"),
    step: Schema.String,
    in: Schema.Array(StepOutcome),
  }),
  Schema.Struct({
    _tag: Schema.Literal("and"),
    items: Schema.Array(Schema.suspend((): Schema.Codec<Condition> => ConditionJson)),
  }),
  Schema.Struct({
    _tag: Schema.Literal("or"),
    items: Schema.Array(Schema.suspend((): Schema.Codec<Condition> => ConditionJson)),
  }),
  Schema.Struct({
    _tag: Schema.Literal("not"),
    item: Schema.suspend((): Schema.Codec<Condition> => ConditionJson),
  }),
]);

const SubFlow = Schema.suspend((): Schema.Codec<Flow> => FlowJson);

export const FlowJson: Schema.Codec<Flow> = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("step"), step: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("seq"),
    exitOn: Schema.Literal("fail"),
    items: Schema.Array(SubFlow),
  }),
  Schema.Struct({ _tag: Schema.Literal("par"), items: Schema.Array(SubFlow) }),
  Schema.Struct({
    _tag: Schema.Literal("cascade"),
    accept: Schema.Array(StepOutcome),
    items: Schema.Array(SubFlow),
  }),
  Schema.Struct({ _tag: Schema.Literal("worlds"), over: Schema.Array(FlowWorld), body: SubFlow }),
  Schema.Struct({ _tag: Schema.Literal("when"), condition: ConditionJson, body: SubFlow }),
  Schema.Struct({
    _tag: Schema.Literal("budget"),
    limit: BudgetJson,
    onExhaust: Schema.Literal("escalate"),
    body: SubFlow,
  }),
]);

export const ReadJson: Schema.Codec<Read> = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("step"), step: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("fact"), fact: Schema.String }),
]);

/** A step's command as the flow file writes it: the timeout and the report may be left out. */
const StepRunJson = Schema.Struct({
  command: Schema.NonEmptyString,
  timeoutMs: Schema.optionalKey(Schema.Int),
  report: Schema.optionalKey(Schema.Struct({ junit: Schema.String })),
});

const stepFields = {
  id: Schema.NonEmptyString,
  kind: StepKind,
  evidenceCeiling: EvidenceClass,
  outcomes: Schema.Array(StepOutcome),
  worlds: Schema.optionalKey(Schema.Array(FlowWorld)),
  budget: BudgetJson,
  tier: Schema.optionalKey(Tier),
  run: Schema.optionalKey(StepRunJson),
};

const AppliesTo = Schema.Struct({
  paths: Schema.Array(Glob),
  subjects: Schema.Array(SubjectKey),
});
const Determinism = Schema.Literals(["deterministic", "nondeterministic"]);

/** Encoded as plain JSON: the brands (hashes, globs, subject keys) are checked on decode. */
export const StepSpecJson: Schema.Codec<StepSpec, unknown> = Schema.Struct({
  ...stepFields,
  version: ContentHash,
  appliesTo: AppliesTo,
  reads: Schema.Array(ReadJson),
  mayskip: Schema.Array(Schema.String),
  overrides: Schema.Array(Schema.String),
  determinism: Determinism,
  suite: Schema.Boolean,
  optional: Schema.Boolean,
});

/** A step as a project writes it: the version and the empty lists may be left out. */
export const StepFileJson = Schema.Struct({
  ...stepFields,
  version: Schema.optionalKey(ContentHash),
  appliesTo: Schema.optionalKey(AppliesTo),
  reads: Schema.optionalKey(Schema.Array(ReadJson)),
  mayskip: Schema.optionalKey(Schema.Array(Schema.String)),
  overrides: Schema.optionalKey(Schema.Array(Schema.String)),
  determinism: Schema.optionalKey(Determinism),
  suite: Schema.optionalKey(Schema.Boolean),
  optional: Schema.optionalKey(Schema.Boolean),
});
export type StepFileJson = typeof StepFileJson.Type;

/** A compiled plan as the plan store keeps it: every field, the hashed ones and the advisory cost. */
export const FlowPlanJson: Schema.Codec<FlowPlan, unknown> = Schema.Struct({
  planHash: ContentHash,
  steps: Schema.Array(PlanStep),
  costEstimate: Schema.Finite,
  flow: FlowJson,
  baseCommit: CommitSha,
  compiler: Schema.String,
  versions: Schema.Record(Schema.String, ContentHash),
  humanClass: Schema.Boolean,
  overrides: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  mayskip: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  members: Schema.optionalKey(Schema.Array(ContentHash)),
});

/**
 * The text a plan store keeps for a plan, or why it must not keep it: a plan
 * whose `planHash` is not its own preimage's (`planHashOf`) could never be
 * read back, so storing it is refused.
 */
export const storedPlanText = (plan: FlowPlan): Result.Result<string, string> => {
  const rehashed = planHashOf(plan);
  return rehashed === plan.planHash
    ? Result.succeed(JSON.stringify(Schema.encodeSync(FlowPlanJson)(plan)))
    : Result.fail(`plan ${plan.planHash} rehashes to ${rehashed}`);
};

/**
 * Reads back a plan stored under `hash`: the text must be a plan, and the plan
 * must rehash to `hash` (`planHashOf`) and claim it as its `planHash`. So a
 * plan read back is the plan that was compiled, never one edited at rest or
 * filed under another plan's key. Anything else is corrupt, with why.
 */
export const readStoredPlan = (
  hash: ContentHash,
  text: string,
): Result.Result<FlowPlan, string> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return Result.fail("not JSON");
  }
  const decoded = Schema.decodeUnknownResult(FlowPlanJson)(json);
  if (Result.isFailure(decoded)) return Result.fail("not a plan");
  const plan = decoded.success;
  const rehashed = planHashOf(plan);
  if (rehashed !== hash) return Result.fail(`rehashes to ${rehashed}`);
  if (plan.planHash !== hash) return Result.fail(`claims ${plan.planHash}`);
  return Result.succeed(plan);
};
