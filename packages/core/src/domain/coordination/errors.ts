import { Schema } from "effect";
import { ChangeId, LeaseId, SketchId, WorkspaceId } from "../kernel/index.ts";
import { ChangeState } from "./change.ts";

export class ChangeNotFound extends Schema.TaggedError<ChangeNotFound>()("ChangeNotFound", { changeId: ChangeId }) {}

/** The call carried a lease that is not the change's active lease. */
export class LeaseStale extends Schema.TaggedError<LeaseStale>()("LeaseStale", { changeId: ChangeId, leaseId: LeaseId }) {}

/** `If-Match` named a revision other than the current one. */
export class RevisionMismatch extends Schema.TaggedError<RevisionMismatch>()("RevisionMismatch", {
  changeId: ChangeId,
  expected: Schema.Int,
  actual: Schema.Int,
}) {}

/** The command is not valid in the change's current state. */
export class ChangeStateRefused extends Schema.TaggedError<ChangeStateRefused>()("ChangeStateRefused", {
  changeId: ChangeId,
  state: ChangeState,
  command: Schema.String,
}) {}

export class SketchNotFound extends Schema.TaggedError<SketchNotFound>()("SketchNotFound", { sketchId: SketchId }) {}

export class WorkspaceNotFound extends Schema.TaggedError<WorkspaceNotFound>()("WorkspaceNotFound", { workspaceId: WorkspaceId }) {}

/** No ready workspace could be granted. */
export class PoolExhausted extends Schema.TaggedError<PoolExhausted>()("PoolExhausted", { retryAfterMs: Schema.Int }) {}

/** The submitted commit is not in the change's workspace. */
export class CommitNotInWorkspace extends Schema.TaggedError<CommitNotInWorkspace>()("CommitNotInWorkspace", {
  changeId: ChangeId,
  commitSha: Schema.String,
}) {}

/**
 * A proposition whose value does not read on its predicate's lattice (see the
 * grammar on `Proposition.value`). It is compared as needs-probe, never as a
 * verdict, and preflight tells the agent the grammar.
 */
export class UnreadableProposition extends Schema.TaggedError<UnreadableProposition>()("UnreadableProposition", {
  subject: Schema.String,
  predicate: Schema.String,
  reason: Schema.String,
}) {}
