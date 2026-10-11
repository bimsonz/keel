import { Schema } from "effect";
import { SubjectKey } from "../../domain/coordination/index.ts";
import { ContentHash, EvidenceClass, Glob, Tier } from "../../domain/kernel/index.ts";
import {
  type Budget,
  type Condition,
  type Flow,
  FlowWorld,
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

const stepFields = {
  id: Schema.NonEmptyString,
  kind: StepKind,
  evidenceCeiling: EvidenceClass,
  outcomes: Schema.Array(StepOutcome),
  worlds: Schema.optionalKey(Schema.Array(FlowWorld)),
  budget: BudgetJson,
  tier: Schema.optionalKey(Tier),
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
