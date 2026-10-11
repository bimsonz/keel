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
  SketchNotFound,
} from "../../domain/coordination/index.ts";
import type { IdempotencyConflict, Principal } from "../../domain/identity/index.ts";
import type {
  ChangeId,
  CommitSha,
  NextAction,
  ProjectId,
  VerdictId,
  WorkspaceId,
} from "../../domain/kernel/index.ts";
import type {
  Adopted,
  AdoptInput,
  Declared,
  DeclareInput,
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

/** Where a change's commits live: its workspace repo and the trunk commit it was granted at. */
export interface ChangeWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly repo: RepoRef;
  readonly baseSha: CommitSha;
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
      principal: Principal,
      input: DeclareInput,
    ) => Effect.Effect<Declared, PoolExhausted | SketchNotFound | IdempotencyConflict>;
    readonly submit: (
      principal: Principal,
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
      principal: Principal,
      input: AdoptInput,
    ) => Effect.Effect<
      Adopted,
      | ChangeNotFound
      | ChangeStateRefused
      | LeaseNotLapsed
      | ChangeInOtherProject
      | IdempotencyConflict
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
