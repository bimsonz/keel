import { Context, type Effect } from "effect";
import type {
  Change,
  ChangeNotFound,
  ChangeStateRefused,
  CommitNotInWorkspace,
  LeaseStale,
  PoolExhausted,
  SketchNotFound,
} from "../../domain/coordination/index.ts";
import type { IdempotencyConflict, Principal } from "../../domain/identity/index.ts";
import type { ChangeId, CommitSha, ProjectId, WorkspaceId } from "../../domain/kernel/index.ts";
import type { Declared, DeclareInput, SubmitInput } from "../coordination/index.ts";
import type { RepoRef } from "./code-host.ts";

/** A change's submission as it stands: the change, and the commit last submitted for it. */
export interface SubmissionStatus {
  readonly change: Change;
  readonly commitSha: CommitSha | null;
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
