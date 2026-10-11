import { Context, type Effect } from "effect";
import type { ChangeNotFound, ChangeStateRefused } from "../../domain/coordination/index.ts";
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
 * Where Precheck diffs a change: its workspace's repo, the base it was granted
 * at (`WorkspaceGranted.baseSha`, so a mirror that lags trunk never loses the
 * base), and the project whose settings hold the protected globs.
 */
export interface PrecheckWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly repo: RepoRef;
  readonly baseSha: CommitSha;
  readonly projectId: ProjectId;
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
    /** Commits PlanCompiled. */
    readonly compiled: (changeId: ChangeId, plan: PrecheckCompiled) => Effect.Effect<void, Refusal>;
  }
>()("keel/ChangePrecheck") {}
