import type { CommitSha, ContentHash, EvidenceClass, Glob, Tier } from "../kernel/index.ts";
import type { SubjectKey } from "../coordination/index.ts";
import type { World } from "./conflict.ts";
import type { PlanStep, StepKind, StepOutcome, VerificationPlan } from "./plan.ts";

/** What a budget node allows its body to spend. */
export type Budget = { readonly usd: number; readonly cpuMs: number; readonly tokens: number };

/** A typed predicate over prior steps' outcomes. */
export type Condition =
  | { readonly _tag: "outcome"; readonly step: string; readonly in: readonly StepOutcome[] }
  | { readonly _tag: "and"; readonly items: readonly Condition[] }
  | { readonly _tag: "or"; readonly items: readonly Condition[] }
  | { readonly _tag: "not"; readonly item: Condition };

/**
 * The flow grammar (ADR 0007). Keel owns the composition; projects supply the steps.
 * - seq stops at the first fail;
 * - cascade stops at the first item whose outcome it accepts, else abstains, which escalates;
 * - worlds runs its body in each world;
 * - when runs its body only if its condition holds over prior outcomes;
 * - budget escalates when its body exhausts the limit.
 */
export type Flow =
  | { readonly _tag: "step"; readonly step: string }
  | { readonly _tag: "seq"; readonly exitOn: "fail"; readonly items: readonly Flow[] }
  | { readonly _tag: "par"; readonly items: readonly Flow[] }
  | { readonly _tag: "cascade"; readonly accept: readonly StepOutcome[]; readonly items: readonly Flow[] }
  | { readonly _tag: "worlds"; readonly over: readonly World[]; readonly body: Flow }
  | { readonly _tag: "when"; readonly condition: Condition; readonly body: Flow }
  | { readonly _tag: "budget"; readonly limit: Budget; readonly onExhaust: "escalate"; readonly body: Flow };

/** What a step reads: another step's result, or one of the change's facts. */
export type Read = { readonly _tag: "step"; readonly step: string } | { readonly _tag: "fact"; readonly fact: string };

/** One typed step, as the project's flow spec declares it. */
export type StepSpec = {
  readonly id: string;
  /** The content hash of the step (or its plugin): `id@version`. */
  readonly version: ContentHash;
  readonly kind: StepKind;
  readonly evidenceCeiling: EvidenceClass;
  /** Paths and subjects the step covers; both empty means every change. */
  readonly appliesTo: { readonly paths: readonly Glob[]; readonly subjects: readonly SubjectKey[] };
  readonly reads: readonly Read[];
  readonly outcomes: readonly StepOutcome[];
  /** Steps this step's outcome may skip. */
  readonly mayskip: readonly string[];
  /** Steps whose fail this step may override. */
  readonly overrides: readonly string[];
  /** The worlds the step can run in, when it is a world-matrix step. */
  readonly worlds?: readonly World[];
  readonly budget: Budget;
  readonly determinism: "deterministic" | "nondeterministic";
  /** A project suite (runs in a container by default), rather than a probe or a pure check. */
  readonly suite: boolean;
  /** A tier the project pins, overriding policy. */
  readonly tier?: Tier;
  readonly optional: boolean;
};

/** A project's flow, read from `.keel/flow` at the change's base commit. */
export type FlowDefinition = { readonly commit: CommitSha; readonly flow: Flow; readonly steps: readonly StepSpec[] };

/** Keel's defaults (a verifier pack): used when the project has no flow, and as steps a project flow may name. */
export type FlowDefaults = { readonly flow: Flow; readonly steps: readonly StepSpec[] };

/** What compile knows about the change. */
export type ChangeFacts = {
  readonly baseCommit: CommitSha;
  readonly touchedPaths: readonly string[];
  /** Subjects the change touches or relies on. */
  readonly subjects: readonly SubjectKey[];
  /** The facts steps may read, with the evidence class each carries. */
  readonly facts: Readonly<Record<string, EvidenceClass>>;
};

export type FlowPolicy = {
  /** Paths whose change makes the plan human-class. */
  readonly humanClassPaths: readonly Glob[];
  /** Tier for project suites, and for everything else, unless the spec pins one. */
  readonly suiteTier: Tier;
  readonly defaultTier: Tier;
};

/** A compiled plan: the wire VerificationPlan with its typed flow tree. */
export type FlowPlan = VerificationPlan & {
  readonly flow: Flow;
  readonly steps: readonly PlanStep[];
  readonly baseCommit: CommitSha;
  /** Set when the change touches the flow itself: a person must rule before it lands. */
  readonly humanClass: boolean;
  /** Step ids whose fails a human step may override, per human step. */
  readonly overrides: Readonly<Record<string, readonly string[]>>;
  readonly mayskip: Readonly<Record<string, readonly string[]>>;
};
