import { Schema } from "effect";
import {
  AgentId,
  ChangeId,
  CommitSha,
  ConflictId,
  EscalationId,
  GuardId,
  InstantSchema,
  LeaseId,
  NamespaceId,
  NextAction,
  ProjectId,
  WorkspaceId,
} from "../kernel/index.ts";
import { ChangeState } from "./change.ts";
import { WorkspaceState } from "./workspace.ts";
import { Drift } from "./derivation.ts";

/**
 * What to do instead. `decideChange` sets it, never empty, on every refusal;
 * it is optional only so a refusal from an older caller still decodes.
 */
const nextActions = Schema.optional(Schema.Array(NextAction));

export class ChangeNotFound extends Schema.TaggedError<ChangeNotFound>()("ChangeNotFound", {
  changeId: ChangeId,
  nextActions,
}) {}

/** A proposal's own command on a change that is no proposal: an agent's, or Keel's. */
export class NotAProposal extends Schema.TaggedError<NotAProposal>()("NotAProposal", {
  changeId: ChangeId,
  nextActions,
}) {}

/** A proposal names a project as its fork that was not forked from the project it is proposed to. */
export class NotAForkOf extends Schema.TaggedError<NotAForkOf>()("NotAForkOf", {
  fork: ProjectId,
  upstream: ProjectId,
}) {}

/** A proposal names a commit its fork's trunk does not hold: only what landed in the fork is proposed. */
export class CommitNotOnFork extends Schema.TaggedError<CommitNotOnFork>()("CommitNotOnFork", {
  fork: ProjectId,
  commit: CommitSha,
}) {}

/** A proposal's commit carries nothing past where its fork last met the project: there is nothing to propose. */
export class ProposalEmpty extends Schema.TaggedError<ProposalEmpty>()("ProposalEmpty", {
  fork: ProjectId,
  commit: CommitSha,
  base: CommitSha,
}) {}

/** The proposer already has `limit` proposals open on the project: one must close or land first. */
export class ProposalLimit extends Schema.TaggedError<ProposalLimit>()("ProposalLimit", {
  projectId: ProjectId,
  limit: Schema.Int,
}) {}

/**
 * An approval, or a request for changes, names a commit the proposal no
 * longer carries: its proposer moved it since the reviewer read it. `current`
 * is the one it carries now.
 */
export class ProposalCommitMoved extends Schema.TaggedError<ProposalCommitMoved>()(
  "ProposalCommitMoved",
  {
    changeId: ChangeId,
    commit: CommitSha,
    current: CommitSha,
    nextActions,
  },
) {}

/**
 * The call carried a lease that is not the change's active lease: another
 * lease's token (`stale`), or the current token after the lease lapsed
 * (`lapsed`, computed from `renewedAt` whether or not the alarm has fired).
 */
export class LeaseStale extends Schema.TaggedError<LeaseStale>()("LeaseStale", {
  changeId: ChangeId,
  leaseId: LeaseId,
  reason: Schema.optional(Schema.Literals(["stale", "lapsed"])),
  nextActions,
}) {}

/**
 * `adopt` by an agent bound to another project. An adopter holds no lease yet,
 * so the change's project is the only authority it is checked against.
 */
export class ChangeInOtherProject extends Schema.TaggedError<ChangeInOtherProject>()(
  "ChangeInOtherProject",
  { changeId: ChangeId },
) {}

/**
 * A submission while the namespace of the caller's project has its
 * verification spend stopped: a verification there runs nothing and bounces
 * every change, so none is taken. `nextActions` says what its owner does: ask
 * for the namespace to be resumed, then submit again.
 */
export class NamespaceHalted extends Schema.TaggedError<NamespaceHalted>()("NamespaceHalted", {
  namespace: NamespaceId,
  nextActions: Schema.Array(NextAction),
}) {}

/**
 * `adopt` while the lease is still alive: adoption needs a Lapsed lease.
 * `lapsesAt` is when it lapses unless renewed; absent while Keel holds the
 * change, when it cannot lapse until Keel hands the change back.
 */
export class LeaseNotLapsed extends Schema.TaggedError<LeaseNotLapsed>()("LeaseNotLapsed", {
  changeId: ChangeId,
  lapsesAt: Schema.optional(InstantSchema),
  nextActions: Schema.Array(NextAction),
}) {}

/**
 * A call under a change's lease from an agent of the change's project that is
 * not the change's agent. The lease is its holder's alone: another agent takes
 * the change over by adopting it once the lease lapses. `lapsesAt` is when it
 * lapses unless renewed, absent while Keel holds the change; `holderName` is
 * the holder as people read it (its handle, or the name a person enrolled it
 * by), filled in by the doorway, which can read the directory.
 */
export class ChangeHeldByOther extends Schema.TaggedError<ChangeHeldByOther>()(
  "ChangeHeldByOther",
  {
    changeId: ChangeId,
    holder: AgentId,
    holderName: Schema.optional(Schema.String),
    lapsesAt: Schema.optional(InstantSchema),
    nextActions: Schema.Array(NextAction),
  },
) {}

/**
 * The change may not be queued, or stay queued, while a Proven conflict is
 * open against it, a guard fails on it, or high-severity drift is unresolved.
 * It may not enter a batch either while a person has yet to rule on one of its
 * conflicts, nor resume from the wait for one ruling while another is still
 * awaited: `escalations` names what it waits for, and is absent otherwise.
 */
export class ChangeBlocked extends Schema.TaggedError<ChangeBlocked>()("ChangeBlocked", {
  changeId: ChangeId,
  conflicts: Schema.Array(ConflictId),
  guards: Schema.Array(GuardId),
  drift: Schema.Array(Drift),
  escalations: Schema.optional(Schema.Array(EscalationId)),
  nextActions: Schema.Array(NextAction),
}) {}

/** `If-Match` named a revision other than the current one. */
export class RevisionMismatch extends Schema.TaggedError<RevisionMismatch>()("RevisionMismatch", {
  changeId: ChangeId,
  expected: Schema.Int,
  actual: Schema.Int,
  nextActions,
}) {}

/** The command is not valid in the change's current state. */
export class ChangeStateRefused extends Schema.TaggedError<ChangeStateRefused>()(
  "ChangeStateRefused",
  {
    changeId: ChangeId,
    state: ChangeState,
    command: Schema.String,
    nextActions,
  },
) {}

export class WorkspaceNotFound extends Schema.TaggedError<WorkspaceNotFound>()(
  "WorkspaceNotFound",
  { workspaceId: WorkspaceId },
) {}

/** No ready workspace could be granted. */
export class PoolExhausted extends Schema.TaggedError<PoolExhausted>()("PoolExhausted", {
  retryAfterMs: Schema.Int,
}) {}

/** The submitted commit is not in the change's workspace. */
export class CommitNotInWorkspace extends Schema.TaggedError<CommitNotInWorkspace>()(
  "CommitNotInWorkspace",
  {
    changeId: ChangeId,
    commitSha: Schema.String,
    nextActions,
  },
) {}

/**
 * A proposition whose value does not read on its predicate's lattice (see the
 * grammar on `Proposition.value`). It is compared as needs-probe, never as a
 * verdict, and preflight tells the agent the grammar.
 */
export class UnreadableProposition extends Schema.TaggedError<UnreadableProposition>()(
  "UnreadableProposition",
  {
    subject: Schema.String,
    predicate: Schema.String,
    reason: Schema.String,
    /** Set when the form is refused rather than malformed, e.g. a premise relying on an invalidation. */
    nextActions,
  },
) {}

/**
 * Why a proposition or a citation cannot cross the MFP 0.2 wire, either way:
 * one side has no form for it, or it does not read, and neither side may
 * repair what does not read.
 */
export const UntellableReason = Schema.Literals([
  /** It does not read on its predicate's lattice (`readClaim`), or a premise relies on an invalidation. */
  "unreadable",
  /** An authority writer 0.2 cannot hold: one with whitespace in it. */
  "writer",
  /** A shape field with an empty, repeated or reserved name, or an opaque shape with an empty one. */
  "shape-name",
  /** A bound's unit 0.2 cannot hold: one with whitespace in it. */
  "unit",
  /** A tool result cited: Keel has no citation of one. */
  "tool-result",
  /** An anchor with no commit, where no working commit was given to stand for it. */
  "anchor-commit",
  /** A message ref that is not `<session>/<seq>`. */
  "message-ref",
]);
export type UntellableReason = typeof UntellableReason.Type;

/** A proposition or a citation that cannot be told across the MFP 0.2 wire, and why. */
export class Untellable extends Schema.TaggedError<Untellable>()("Untellable", {
  what: Schema.Literals(["proposition", "citation"]),
  reason: UntellableReason,
  detail: Schema.String,
}) {}

/** A probe's cost must be a positive, finite number: blast is divided by it. */
export class InvalidProbeCost extends Schema.TaggedError<InvalidProbeCost>()("InvalidProbeCost", {
  /** The refused cost when it was a finite number; absent for NaN or ±Infinity, which JSON cannot carry. */
  cost: Schema.optional(Schema.Finite),
}) {}

/** The command is not valid in the workspace's current state, or names another holder. */
export class WorkspaceStateRefused extends Schema.TaggedError<WorkspaceStateRefused>()(
  "WorkspaceStateRefused",
  {
    workspaceId: WorkspaceId,
    state: Schema.optional(WorkspaceState),
    command: Schema.String,
  },
) {}
