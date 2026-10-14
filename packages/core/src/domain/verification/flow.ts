import type {
  CommitSha,
  ContentHash,
  DecisionId,
  EvidenceClass,
  Glob,
  GuardId,
  TenetId,
  Tier,
} from "../kernel/index.ts";
import type {
  Predicate,
  PredicatePolicies,
  Proposition,
  SubjectKey,
} from "../coordination/index.ts";
import type { DeploySpec } from "../delivery/index.ts";
import type { FlowWorld } from "./conflict.ts";
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
  | {
      readonly _tag: "cascade";
      readonly accept: readonly StepOutcome[];
      readonly items: readonly Flow[];
    }
  | { readonly _tag: "worlds"; readonly over: readonly FlowWorld[]; readonly body: Flow }
  | { readonly _tag: "when"; readonly condition: Condition; readonly body: Flow }
  | {
      readonly _tag: "budget";
      readonly limit: Budget;
      readonly onExhaust: "escalate";
      readonly body: Flow;
    };

/** What a step reads: another step's result, or one of the change's facts. */
export type Read =
  | { readonly _tag: "step"; readonly step: string }
  | { readonly _tag: "fact"; readonly fact: string };

/** The active decision a guard holds: a ruling upheld the proposition it asserts. */
export type HeldDecision = { readonly id: DecisionId; readonly summary: string };

/**
 * What a guard step guards and runs: a tenet's predicate, and the admitted
 * probe bundle it runs, by content hash. The verifier fetches that bundle from
 * the guard store by its hash, never from the candidate's `.keel/guards/`.
 * With the decision it holds, its fail blocks whatever the predicate's policy.
 */
export type GuardSpec = {
  readonly predicate: Predicate;
  readonly probe: ContentHash;
  readonly decision?: HeldDecision;
};

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
  readonly worlds?: readonly FlowWorld[];
  readonly budget: Budget;
  readonly determinism: "deterministic" | "nondeterministic";
  /** A project suite (runs in a container by default), rather than a probe or a pure check. */
  readonly suite: boolean;
  /** A tier the project pins, overriding policy. */
  readonly tier?: Tier;
  readonly optional: boolean;
  /** The step guards a tenet (it runs an admitted probe), so its fail takes that predicate's policy. */
  readonly guards?: GuardSpec;
  /**
   * A command of the project's own, run in a container and judged by its exit
   * status; the timeout, when left out, is the suite's (STEP_RUN_TIMEOUT_MS).
   */
  readonly run?: { readonly command: string; readonly timeoutMs?: number };
  /**
   * The project's deploy spec, as its base's `.keel/deploy.json` says, for a
   * step that builds, previews or smokes its Worker: it rides on the plan, so
   * the candidate's own deploy spec is never what runs.
   */
  readonly deploy?: DeploySpec;
};

/** A step command's timeout when the flow leaves it out: the suite's own. */
export const STEP_RUN_TIMEOUT_MS = 4 * 60_000;
/** The longest a step command may be given to run. */
export const STEP_RUN_TIMEOUT_MAX_MS = 20 * 60_000;
/** The longest a step command may be, in UTF-16 code units (a character outside the BMP counts two). */
export const STEP_RUN_COMMAND_MAX = 4096;

/** A project's flow, read from `.keel/flow` at the change's base commit. */
export type FlowDefinition = {
  readonly commit: CommitSha;
  readonly flow: Flow;
  readonly steps: readonly StepSpec[];
};

/** Keel's defaults (a verifier pack): used when the project has no flow, and as steps a project flow may name. */
export type FlowDefaults = { readonly flow: Flow; readonly steps: readonly StepSpec[] };

/**
 * An admitted guard, as the AdmittedGuards port reads it: `GuardAdmitted`, the bundle its
 * probe was admitted with, and the tenet it guards (`TenetEstablished`).
 */
export type AdmittedGuard = {
  readonly guardId: GuardId;
  /** The admitted probe bundle the guard runs, by content hash. */
  readonly probe: ContentHash;
  /**
   * The proposition the guard holds, from its guard.json, and the tenet that
   * guards it once TenetEstablished names one: admission comes first, so the
   * id may be absent while selection already works from the proposition.
   */
  readonly tenet: { readonly id?: TenetId; readonly proposition: Proposition };
  /** The active decision the guard holds, once a ruling upheld its proposition (ADR 0005). */
  readonly decision?: HeldDecision;
};

/** What compile knows about the change. */
export type ChangeFacts = {
  readonly baseCommit: CommitSha;
  readonly touchedPaths: readonly string[];
  /** Subjects the change touches or relies on. */
  readonly subjects: readonly SubjectKey[];
  /** The facts steps may read, with the evidence class each carries. */
  readonly facts: Readonly<Record<string, EvidenceClass>>;
  /**
   * The project's predicate policy, composed for the change from its base
   * commit: per predicate, what a guard's proven fail does. A predicate it
   * leaves out is `advise` (ADR 0005).
   */
  readonly predicatePolicy?: PredicatePolicies;
  /**
   * The project's admitted guards. Compile selects the ones the change is
   * exposed to (`selectGuards`) and runs them alongside the project's flow.
   */
  readonly admittedGuards?: readonly AdmittedGuard[];
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
  /** The compiler that produced it (`COMPILER_VERSION`), so a stored plan can be rehashed. */
  readonly compiler: string;
  /** Each planned step's content hash (`StepSpec.version`), by step id. */
  readonly versions: Readonly<Record<string, ContentHash>>;
  /** Set when the change touches the flow itself: a person must rule before it lands. */
  readonly humanClass: boolean;
  /** Step ids whose fails a human step may override, per human step. */
  readonly overrides: Readonly<Record<string, readonly string[]>>;
  readonly mayskip: Readonly<Record<string, readonly string[]>>;
  /** Set on a batch's union only: the member plans it unions, by planHash, sorted. */
  readonly members?: readonly ContentHash[];
};

/** Everything a plan's hash covers: all of the plan but the hash and the advisory cost. */
export type PlanPreimage = Omit<FlowPlan, "planHash" | "costEstimate">;
