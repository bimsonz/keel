import { Context, type Effect } from "effect";
import type {
  Change,
  ChangeInOtherProject,
  ChangeNotFound,
  ChangeStateRefused,
  CommitNotInWorkspace,
  LeaseNotLapsed,
  LeaseStale,
  PoolExhausted,
  Preflight,
  RevisionMismatch,
  SketchNotFound,
} from "../../domain/coordination/index.ts";
import type { IdempotencyConflict, AgentToken } from "../../domain/identity/index.ts";
import type {
  ChangeId,
  CommitSha,
  NextAction,
  ProjectId,
  VerdictId,
  WorkspaceId,
} from "../../domain/kernel/index.ts";
import type { PackTooLarge } from "./trunk-writer.ts";
import type { PushRejected } from "../../domain/integration/index.ts";
import type {
  AbandonInput,
  Adopted,
  AdoptInput,
  Declared,
  DeclareInput,
  RebasedChange,
  RebaseInput,
  RelyInput,
  ReviseInput,
  Revised,
  SubmitInput,
} from "../coordination/index.ts";
import type { RepoRef } from "./code-host.ts";

/** What a bounce asked of the agent, verbatim: the verdict, its reasons and its next actions. */
export interface Remedy {
  readonly verdictId: VerdictId;
  readonly reasons: readonly string[];
  readonly nextActions: readonly NextAction[];
}

/**
 * A change's submission as it stands: the change, the commit last submitted
 * for it, and the remedy its last bounce asked for, until a submission
 * answers it. A park keeps it: the lease lapsing changes who acts, not what to do.
 */
export interface SubmissionStatus {
  readonly change: Change;
  readonly commitSha: CommitSha | null;
  readonly remedy?: Remedy;
}

/**
 * Where a change's commits live: its workspace repo, its base (the grant's
 * until a rebase moves it) and the trunk commit it was granted at, which never moves.
 */
export interface ChangeWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly repo: RepoRef;
  readonly baseSha: CommitSha;
  readonly grantedSha: CommitSha;
  readonly projectId: ProjectId;
}

/**
 * The isolate's way to the Change DOs (`change:<ULID>`). Each call is one RPC
 * to the change's own DO, which decides and authorises; the lease is checked
 * there and only there, so the isolate passes the `Keel-Lease` value through.
 *
 * `declare` is idempotent by Idempotency-Key: the agent's AgentSession DO
 * reserves the change id for the key (24 h), so a retry reaches the same
 * change, and a reused key with a different body is an IdempotencyConflict.
 */
export class Changes extends Context.Service<
  Changes,
  {
    readonly declare: (
      principal: AgentToken,
      input: DeclareInput,
    ) => Effect.Effect<Declared, PoolExhausted | SketchNotFound | IdempotencyConflict>;
    readonly submit: (
      principal: AgentToken,
      input: SubmitInput,
    ) => Effect.Effect<
      Change,
      ChangeNotFound | LeaseStale | ChangeStateRefused | CommitNotInWorkspace | IdempotencyConflict
    >;
    /**
     * Takes over a change whose lease lapsed: a new lease that fences the old
     * token, and a fresh token for the change's workspace. Idempotent by
     * Idempotency-Key per change; the same key from another caller is an
     * IdempotencyConflict.
     */
    readonly adopt: (
      principal: AgentToken,
      input: AdoptInput,
    ) => Effect.Effect<
      Adopted,
      | ChangeNotFound
      | ChangeStateRefused
      | LeaseNotLapsed
      | ChangeInOtherProject
      | IdempotencyConflict
    >;
    /**
     * Moves the change onto trunk's head after a textual bounce: trunk's head
     * goes on the workspace's `keel/trunk`, and the change's base moves there.
     * Working or Bounced, under the lease; idempotent by Idempotency-Key per
     * change. PushRejected: the workspace stayed busy, or kept moving (retry).
     */
    readonly rebase: (
      principal: AgentToken,
      input: RebaseInput,
    ) => Effect.Effect<
      RebasedChange,
      | ChangeNotFound
      | LeaseStale
      | ChangeStateRefused
      | IdempotencyConflict
      | PushRejected
      | PackTooLarge
    >;
    /**
     * Revises the intent under the lease, at the revision the caller last read
     * (RevisionMismatch otherwise), and answers the preflight of the intent it
     * leaves. Idempotent by Idempotency-Key per change.
     */
    readonly revise: (
      principal: AgentToken,
      input: ReviseInput,
    ) => Effect.Effect<
      Revised,
      ChangeNotFound | LeaseStale | RevisionMismatch | ChangeStateRefused | IdempotencyConflict
    >;
    /** Adds one premise under the lease, subscribing the change to its subject; idempotent by Idempotency-Key per change. */
    readonly rely: (
      principal: AgentToken,
      input: RelyInput,
    ) => Effect.Effect<
      Revised,
      ChangeNotFound | LeaseStale | ChangeStateRefused | IdempotencyConflict
    >;
    /** The preflight of the change's intent as it stands; commits nothing. Only for an agent of the change's project. */
    readonly nearby: (
      principal: AgentToken,
      changeId: ChangeId,
    ) => Effect.Effect<Preflight, ChangeNotFound | ChangeInOtherProject>;
    /**
     * Withdraws a change under its lease, or as an operator: the change ends
     * and its workspace is released. Idempotent by Idempotency-Key per change;
     * the same key with another body is an IdempotencyConflict.
     */
    readonly abandon: (
      principal: AgentToken,
      input: AbandonInput,
    ) => Effect.Effect<
      Change,
      ChangeNotFound | LeaseStale | ChangeStateRefused | IdempotencyConflict
    >;
    readonly get: (changeId: ChangeId) => Effect.Effect<Change, ChangeNotFound>;
    /**
     * The change once its submission state moves, or as it stands when
     * `waitSeconds` (0–30) runs out. A DO evicted mid-wait answers its current
     * state, never an error.
     */
    /** The change's workspace; ChangeStateRefused before it holds one. The Lane reads a member's repo and base here. */
    readonly workspace: (
      changeId: ChangeId,
    ) => Effect.Effect<ChangeWorkspace, ChangeNotFound | ChangeStateRefused>;
    readonly awaitSubmission: (
      changeId: ChangeId,
      waitSeconds: number,
    ) => Effect.Effect<SubmissionStatus, ChangeNotFound>;
  }
>()("keel/Changes") {}
