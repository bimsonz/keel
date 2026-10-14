import { Context, type Effect } from "effect";
import type {
  ChangeNotFound,
  ChangeStateRefused,
  DerivedEffect,
  Intent,
  PredicatePolicies,
  SubjectKey,
  TouchedAnchor,
} from "../../domain/coordination/index.ts";
import type {
  ChangeId,
  CommitSha,
  ContentHash,
  NextAction,
  ProjectId,
  VerdictId,
  WorkspaceId,
} from "../../domain/kernel/index.ts";
import type { RepoRef } from "./code-host.ts";

/**
 * Where Precheck diffs a change: its workspace's repo, its base (the grant's
 * until a rebase moves it), the commit it was granted at (`grantedSha`, its
 * fork point, which never moves), the project whose settings hold the
 * protected globs, the subjects the change declared it touches or relies
 * on (its premises' and effects'), which compile selects guards by, and its
 * current intent, which derivation reads what it declared from.
 */
export interface PrecheckWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly repo: RepoRef;
  readonly baseSha: CommitSha;
  readonly grantedSha: CommitSha;
  readonly projectId: ProjectId;
  /** The subject of each premise and declared effect of the change's current intent, each once and without ancestors. */
  readonly subjects: readonly SubjectKey[];
  readonly intent: Intent;
}

/** Which submission a Precheck step is about, and which Workflow instance is taking it. */
export interface PrecheckCall {
  readonly revision: number;
  readonly instanceId: string;
}

/** Precheck refused the submission: why, and what the agent can do about it. */
export interface PrecheckRefused extends PrecheckCall {
  readonly reasons: readonly [string, ...string[]];
  readonly nextActions: readonly [NextAction, ...NextAction[]];
}

/** Precheck passed the submission and compiled its Verification Plan. */
export interface PrecheckCompiled extends PrecheckCall {
  readonly planHash: ContentHash;
  readonly steps: number;
  readonly costEstimate: number;
  /** The plan's predicate policy, read at the base commit; absent, or a predicate left out, is `advise`. */
  readonly predicatePolicy?: PredicatePolicies | undefined;
}

/** Precheck derived the submission's effects from its code: `derivationRef` is Precheck's own name for the derivation. */
export interface PrecheckDerived extends PrecheckCall {
  readonly effects: readonly DerivedEffect[];
  readonly derivationRef: string;
  /** The live anchors the submitted diff touches: each such subject hears the derivation too. */
  readonly touched?: readonly TouchedAnchor[] | undefined;
}

type Refusal = ChangeNotFound | ChangeStateRefused;

/**
 * Precheck's way to the change it checks: the Change DO (`change:<ULID>`),
 * reached only through its RPC contract. Every write is idempotent by
 * `instanceId`, so a replayed step commits nothing new, and a `revision` other
 * than the change's current one is ChangeStateRefused, so a stale Precheck
 * never moves a resubmitted change.
 */
export class ChangePrecheck extends Context.Service<
  ChangePrecheck,
  {
    /** The workspace the change holds. ChangeStateRefused before it holds one. */
    readonly workspace: (changeId: ChangeId) => Effect.Effect<PrecheckWorkspace, Refusal>;
    /** Commits PrecheckStarted. */
    readonly started: (changeId: ChangeId, call: PrecheckCall) => Effect.Effect<void, Refusal>;
    /** Commits a ruling-class VerdictIssued (bounce) and ChangeBounced naming it; answers that verdict. */
    readonly refused: (
      changeId: ChangeId,
      refusal: PrecheckRefused,
    ) => Effect.Effect<VerdictId, Refusal>;
    /**
     * Commits EffectsDerived, and has the subject of each derived effect (and
     * its ancestors) hear it. Once per Precheck pass, while the change derives:
     * a second derivation in the pass is ChangeStateRefused.
     */
    readonly derived: (
      changeId: ChangeId,
      derived: PrecheckDerived,
    ) => Effect.Effect<void, Refusal>;
    /** Commits PlanCompiled and queues the change, or bounces it citing a conflict proven against it that blocks under the plan's policy. */
    readonly compiled: (changeId: ChangeId, plan: PrecheckCompiled) => Effect.Effect<void, Refusal>;
  }
>()("keel/ChangePrecheck") {}
