import {
  Change,
  ChangeHeldByOther,
  ChangeInOtherProject,
  ChangeNotFound,
  ChangeOrigin,
  ChangeStateRefused,
  CommitNotInWorkspace,
  DerivedEffect,
  TouchedAnchor,
  FootprintEntry,
  Intent,
  LeaseNotLapsed,
  LeaseStale,
  PoolExhausted,
  PredicatePolicies,
  Preflight,
  Proposition,
  RevisionMismatch,
  SubjectKey,
} from "@keeltown/core/domain/coordination";
import { DeployTargetName } from "@keeltown/core/domain/delivery";
import { IdempotencyConflict } from "@keeltown/core/domain/identity";
import { PushRejected } from "@keeltown/core/domain/integration";
import { PackTooLarge } from "./trunk.ts";
import {
  AgentId,
  CandidateId,
  ChangeId,
  CommitSha,
  ConflictId,
  ContentHash,
  DecisionId,
  DeploymentId,
  LeaseId,
  NextAction,
  ProjectId,
  RunRef,
  UserId,
  VerdictId,
  WorkspaceId,
} from "@keeltown/core/kernel";
import { Effect, Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";
import { RepoRef, WorkspaceGrant } from "./workspace-pool.ts";

/**
 * Declare a change. `changeId` is the one the agent's AgentSession reserved for
 * `idempotencyKey`; the DO checks it against its own name. The key is the
 * commit's cause and `fingerprint` (a hash of the request body) tells a retry
 * from a reused key. The DO takes its workspace with `WorkspacePool.grant(projectId, changeId)`.
 */
export const DeclareCommand = Schema.Struct({
  changeId: ChangeId,
  agentId: AgentId,
  /** The run of the agent that asks, when its token names one. */
  run: Schema.optional(RunRef),
  projectId: ProjectId,
  /** Absent means `agent`; the Auditor's revert declares through a platform path. */
  origin: ChangeOrigin.pipe(Schema.withDecodingDefaultKey(Effect.succeed("agent" as const))),
  goal: Schema.NonEmptyString,
  footprint: Schema.Array(FootprintEntry),
  premises: Schema.Array(Proposition),
  declaredEffects: Schema.optional(Schema.Array(Proposition)),
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});
export type DeclareCommand = typeof DeclareCommand.Type;

/** Submit a commit for a change. The DO authorises the lease and the caller's project; the key is the commit's cause. */
export const SubmitCommand = Schema.Struct({
  agentId: AgentId,
  /** The caller's project, from its token: a change of another project reads as not found. */
  projectId: ProjectId,
  /** The run of the agent that asks, when its token names one. */
  run: Schema.optional(RunRef),
  leaseId: LeaseId,
  commitSha: CommitSha,
  idempotencyKey: Schema.String,
});
export type SubmitCommand = typeof SubmitCommand.Type;

/** Move a change onto trunk's head under its lease, after a textual bounce. */
export const RebaseCommand = Schema.Struct({
  agentId: AgentId,
  /** The caller's project, from its token: a change of another project reads as not found. */
  projectId: ProjectId,
  /** The run of the agent that asks, when its token names one. */
  run: Schema.optional(RunRef),
  leaseId: LeaseId,
  idempotencyKey: Schema.String,
});
export type RebaseCommand = typeof RebaseCommand.Type;

/** One edit an agent commits: a file's new content (base64 on the wire), or its deletion. */
export const CommitEdit = Schema.Union([
  Schema.Struct({
    path: Schema.String,
    content: Schema.Uint8ArrayFromBase64,
    executable: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ path: Schema.String, delete: Schema.Literal(true) }),
]);

/** Commit edits in the change's workspace under its lease, with no clone. */
export const CommitCommand = Schema.Struct({
  agentId: AgentId,
  /** The caller's project, from its token: a change of another project reads as not found. */
  projectId: ProjectId,
  /** The run of the agent that asks, when its token names one. */
  run: Schema.optional(RunRef),
  /** The agent's handle, which authors the commit. */
  handle: Schema.optional(Schema.String),
  leaseId: LeaseId,
  expectedHead: CommitSha,
  parent: Schema.optional(CommitSha),
  edits: Schema.Array(CommitEdit),
  message: Schema.String,
  idempotencyKey: Schema.String,
});
export type CommitCommand = typeof CommitCommand.Type;

/**
 * A fresh token for the workspace the change holds, for its own agent under
 * its lease. `projectId` is the caller's, from its token: another agent's
 * change, or one of another project, reads as not found.
 */
export const RefreshCommand = Schema.Struct({
  agentId: AgentId,
  projectId: ProjectId,
  leaseId: LeaseId,
});
export type RefreshCommand = typeof RefreshCommand.Type;

/** The WorkspaceWriter port's errors, by shape (rule R15). */
export const WorkspaceHeadMoved = Schema.TaggedStruct("WorkspaceHeadMoved", {
  expected: Schema.String,
  head: Schema.NullOr(Schema.String),
});
export const EditsRefused = Schema.TaggedStruct("EditsRefused", {
  reason: Schema.Literals([
    "bad-path",
    "duplicate-path",
    "nested-paths",
    "through-file",
    "is-directory",
    "missing",
    "not-a-file",
    "nothing-changed",
  ]),
  path: Schema.String,
});
/** The Change's CommitParentRefused, by shape (rule R15): a parent that is neither the head read nor the change's base. */
export const CommitParentRefused = Schema.TaggedStruct("CommitParentRefused", {
  changeId: Schema.String,
  parent: Schema.String,
  expectedHead: Schema.String,
  base: Schema.optional(Schema.String),
});
export const ObjectNotFound = Schema.TaggedStruct("ObjectNotFound", {
  repo: RepoRef,
  oid: Schema.String,
});

/** Revise a change's intent under its lease. `ifMatchRevision` is the revision the caller last read (If-Match). */
export const ReviseCommand = Schema.Struct({
  agentId: AgentId,
  /** The caller's project, from its token: a change of another project reads as not found. */
  projectId: ProjectId,
  /** The run of the agent that asks, when its token names one. */
  run: Schema.optional(RunRef),
  leaseId: LeaseId,
  ifMatchRevision: Schema.Int,
  goal: Schema.optional(Schema.NonEmptyString),
  footprint: Schema.optional(Schema.Array(FootprintEntry)),
  premisesAdded: Schema.Array(Proposition),
  premisesRetracted: Schema.Array(Proposition),
  declaredEffects: Schema.optional(Schema.Array(Proposition)),
  idempotencyKey: Schema.String,
});
export type ReviseCommand = typeof ReviseCommand.Type;

/** Add one premise to a change under its lease. */
export const RelyCommand = Schema.Struct({
  agentId: AgentId,
  /** The caller's project, from its token: a change of another project reads as not found. */
  projectId: ProjectId,
  /** The run of the agent that asks, when its token names one. */
  run: Schema.optional(RunRef),
  leaseId: LeaseId,
  premise: Proposition,
  idempotencyKey: Schema.String,
});
export type RelyCommand = typeof RelyCommand.Type;

/** Record why a decision does not govern the change, under its lease. */
export const DistinguishCommand = Schema.Struct({
  agentId: AgentId,
  /** The caller's project, from its token: a change of another project reads as not found. */
  projectId: ProjectId,
  /** The run of the agent that asks, when its token names one. */
  run: Schema.optional(RunRef),
  leaseId: LeaseId,
  decisionId: DecisionId,
  distinction: Schema.String,
  idempotencyKey: Schema.String,
});
export type DistinguishCommand = typeof DistinguishCommand.Type;

/** Read what is near a change. `projectId` is the one the reader was authorised on: a change in another project is ChangeInOtherProject. */
export const NearbyCommand = Schema.Struct({ projectId: ProjectId });
export type NearbyCommand = typeof NearbyCommand.Type;

/** A Workflow instance to tell, once, of the change's next submission or end: `workflow:<Name>/<instanceId>`. */
export const AwaitSubmissionCommand = Schema.Struct({
  subscriber: Schema.String.check(Schema.isPattern(/^workflow:[A-Za-z]+\/\S+$/)),
});
export type AwaitSubmissionCommand = typeof AwaitSubmissionCommand.Type;

/** A Workflow instance to tell, once, of the event that ends the change's Precheck: `workflow:<Name>/<instanceId>`. */
export const AwaitPlanCommand = AwaitSubmissionCommand;
export type AwaitPlanCommand = typeof AwaitPlanCommand.Type;

/**
 * Who may withdraw a change: the agent holding it, under its lease, or a
 * maintainer of its project (a parked change, say), whom the doorway
 * authorised. A maintainer of another project is answered ChangeNotFound.
 */
export const WithdrawAuthority = Schema.Union([
  Schema.TaggedStruct("Lease", {
    leaseId: LeaseId,
    agentId: AgentId,
    /** The agent's project, from its token: only the agent holding the change withdraws it under its lease. */
    projectId: ProjectId,
    run: Schema.optional(RunRef),
  }),
  Schema.TaggedStruct("Maintainer", { by: UserId, projectId: ProjectId }),
]);
export type WithdrawAuthority = typeof WithdrawAuthority.Type;

/** Withdraw a change. */
export const AbandonCommand = Schema.Struct({
  authority: WithdrawAuthority,
  reason: Schema.optional(Schema.String),
  idempotencyKey: Schema.String,
});
export type AbandonCommand = typeof AbandonCommand.Type;

/**
 * Adopt a change whose lease has lapsed: `agentId` takes a new lease, which
 * fences the old token. `projectId` is the adopter's, from its token: a change
 * in another project is ChangeInOtherProject.
 */
export const AdoptCommand = Schema.Struct({
  agentId: AgentId,
  /** The run of the agent that asks, when its token names one. */
  run: Schema.optional(RunRef),
  projectId: ProjectId,
  idempotencyKey: Schema.String,
});
export type AdoptCommand = typeof AdoptCommand.Type;

/** A change's submission as it stands: the change, the commit last submitted for it, and the remedy its last bounce asked for. */
export const SubmissionStatus = Schema.Struct({
  change: Change,
  commitSha: Schema.NullOr(CommitSha),
  remedy: Schema.optionalKey(
    Schema.Struct({
      verdictId: Schema.optionalKey(VerdictId),
      conflictId: Schema.optionalKey(ConflictId),
      reasons: Schema.Array(Schema.String),
      nextActions: Schema.Array(NextAction),
    }),
  ),
});

/**
 * Where Precheck diffs a change: its workspace repo; its base (the change's
 * own `baseSha`: the grant's until a rebase moves it); the commit it was
 * granted at (`grantedSha`, its fork point, which never moves, so an ancestry
 * walk can stop there); the project whose settings hold `protectedPaths`;
 * the subjects the change's intent names, which the plan's guards are
 * compiled against; and that intent, which derivation reads what the change
 * declared from.
 */
export const ChangeWorkspace = Schema.Struct({
  workspaceId: WorkspaceId,
  repo: RepoRef,
  baseSha: CommitSha,
  grantedSha: CommitSha,
  projectId: ProjectId,
  subjects: Schema.Array(SubjectKey),
  intent: Intent,
});
export type ChangeWorkspace = typeof ChangeWorkspace.Type;

// Precheck's commands. Each is idempotent by `instanceId`: the commit's cause
// is `<instanceId>:<method>`, so a replayed Workflow step commits nothing new.
// A `revision` other than the change's current one is refused with
// ChangeStateRefused, so a stale Precheck can never move a resubmitted change.

/** Precheck has started on a submission: commits PrecheckStarted. */
export const PrecheckStartedCommand = Schema.Struct({
  revision: Schema.Int,
  instanceId: Schema.NonEmptyString,
});
export type PrecheckStartedCommand = typeof PrecheckStartedCommand.Type;

/**
 * Precheck refused the submission. Commits, in one transaction, VerdictIssued
 * (outcome `bounce`, evidence class `ruling`, citing the refused paths) on the
 * verdict entity and ChangeBounced naming that verdict, with these next actions.
 */
export const PrecheckRefusedCommand = Schema.Struct({
  revision: Schema.Int,
  instanceId: Schema.NonEmptyString,
  reasons: Schema.NonEmptyArray(Schema.String),
  /** What the agent can do about it; ChangeBounced carries them, never empty. */
  nextActions: Schema.NonEmptyArray(NextAction),
});
export type PrecheckRefusedCommand = typeof PrecheckRefusedCommand.Type;

/**
 * Precheck passed and compiled the change's Verification Plan: commits
 * PlanCompiled and queues the change, unless a conflict proven against it
 * blocks under the plan's predicate policy (absent, or a predicate left out,
 * is `advise`).
 */
export const PlanCompiledCommand = Schema.Struct({
  revision: Schema.Int,
  instanceId: Schema.NonEmptyString,
  planHash: ContentHash,
  steps: Schema.Int,
  costEstimate: Schema.Number,
  predicatePolicy: Schema.optional(PredicatePolicies),
  /** The plan holds the human-class gate: the change parks for a maintainer's ruling as it is queued. */
  needsRuling: Schema.optional(Schema.Literal(true)),
});
export type PlanCompiledCommand = typeof PlanCompiledCommand.Type;

/**
 * Precheck derived the submission's effects from its code: commits
 * EffectsDerived, whose affected subjects (each effect's, with its ancestors)
 * hear it from this commit on. Once per Precheck pass, while the change
 * derives: a second derivation in the pass is ChangeStateRefused.
 * `derivationRef` is Precheck's own name for the derivation.
 */
export const EffectsDerivedCommand = Schema.Struct({
  revision: Schema.Int,
  instanceId: Schema.NonEmptyString,
  effects: Schema.Array(DerivedEffect),
  derivationRef: Schema.NonEmptyString,
  /** The live anchors the submitted diff touches; absent from a Precheck from before they were kept. */
  touched: Schema.optional(Schema.Array(TouchedAnchor)),
  /** The paths the submitted diff touches; absent from a Precheck from before they were kept. */
  paths: Schema.optional(Schema.Array(Schema.String)),
});
export type EffectsDerivedCommand = typeof EffectsDerivedCommand.Type;

/**
 * Tell the change where its candidate's preview answers (core's
 * `tellPreview`), from KeelVerify's preview step: commits PreviewDeployed on
 * the change's stream, once per `deploymentId`. `changeId` is checked against
 * the object's own name. A change the object never made is told nothing.
 */
export const TellPreviewCommand = Schema.Struct({
  changeId: ChangeId,
  deploymentId: DeploymentId,
  candidateId: CandidateId,
  target: DeployTargetName,
  /** The candidate's own version. */
  url: Schema.String,
  /** The change's stable address, when the candidate is that one change's. */
  aliasUrl: Schema.optionalKey(Schema.String),
});

const PrecheckRefusal = Schema.Union([ChangeNotFound, ChangeStateRefused]);

// A reused Idempotency-Key with another body is IdempotencyConflict on every keyed call.
const Mutation = Schema.Union([
  ChangeNotFound,
  ChangeHeldByOther,
  LeaseStale,
  RevisionMismatch,
  ChangeStateRefused,
  IdempotencyConflict,
]);

/** A wait's answer: the change with its project, or `waiting` with the subscriber recorded. */
const AwaitedChange = Schema.Union([
  Schema.Struct({ change: Change, projectId: ProjectId }),
  Schema.Struct({ waiting: Schema.Literal(true) }),
]);

export const ChangeCodecs = {
  get: exitCodec(
    Schema.Struct({
      change: Change,
      projectId: ProjectId,
      unsettled: Schema.optional(Schema.Array(ChangeId)),
    }),
    ChangeNotFound,
  ),
  awaitSubmission: exitCodec(AwaitedChange, ChangeNotFound),
  awaitPlan: exitCodec(AwaitedChange, ChangeNotFound),
  declare: exitCodec(
    Schema.Struct({ change: Change, preflight: Preflight, grant: WorkspaceGrant }),
    Schema.Union([ChangeStateRefused, PoolExhausted, IdempotencyConflict]),
  ),
  revise: exitCodec(Schema.Struct({ change: Change, preflight: Preflight }), Mutation),
  // A rely names no revision: RevisionMismatch belongs to revise alone.
  rely: exitCodec(
    Schema.Struct({ change: Change, preflight: Preflight }),
    Schema.Union([
      ChangeNotFound,
      ChangeHeldByOther,
      LeaseStale,
      ChangeStateRefused,
      IdempotencyConflict,
    ]),
  ),
  distinguish: exitCodec(
    Change,
    Schema.Union([ChangeNotFound, ChangeHeldByOther, LeaseStale, IdempotencyConflict]),
  ),
  nearby: exitCodec(Preflight, Schema.Union([ChangeNotFound, ChangeInOtherProject])),
  // Submit carries no revision: RevisionMismatch belongs to revise alone.
  submit: exitCodec(
    Change,
    Schema.Union([
      ChangeNotFound,
      ChangeHeldByOther,
      LeaseStale,
      ChangeStateRefused,
      CommitNotInWorkspace,
      IdempotencyConflict,
    ]),
  ),
  // Nor does abandon.
  abandon: exitCodec(
    Change,
    Schema.Union([
      ChangeNotFound,
      ChangeHeldByOther,
      LeaseStale,
      ChangeStateRefused,
      IdempotencyConflict,
    ]),
  ),
  // PushRejected: the workspace stayed busy or kept moving; PackTooLarge: trunk's new history is over the relay cap.
  rebase: exitCodec(
    Schema.Struct({
      change: Change,
      ref: Schema.Literal("refs/heads/keel/trunk"),
      base: CommitSha,
    }),
    Schema.Union([
      ChangeNotFound,
      ChangeHeldByOther,
      LeaseStale,
      ChangeStateRefused,
      IdempotencyConflict,
      PushRejected,
      PackTooLarge,
    ]),
  ),
  // The writer's refusals by shape; the change answered has its lease renewed.
  commit: exitCodec(
    Schema.Struct({
      change: Change,
      commit: Schema.Struct({ commitSha: CommitSha, tree: Schema.String, changed: Schema.Number }),
      parent: CommitSha,
    }),
    Schema.Union([
      ChangeNotFound,
      ChangeHeldByOther,
      LeaseStale,
      ChangeStateRefused,
      IdempotencyConflict,
      CommitParentRefused,
      WorkspaceHeadMoved,
      EditsRefused,
      ObjectNotFound,
      PackTooLarge,
    ]),
  ),
  // The same workspace with a fresh token; an ended change never reaches the pool.
  refreshWorkspace: exitCodec(
    WorkspaceGrant,
    Schema.Union([ChangeNotFound, ChangeHeldByOther, LeaseStale, ChangeStateRefused]),
  ),
  // LeaseNotLapsed: adoption needs a Lapsed lease. `grant` re-mints the held workspace's token.
  adopt: exitCodec(
    Schema.Struct({ change: Change, grant: Schema.optional(WorkspaceGrant) }),
    Schema.Union([
      ChangeNotFound,
      ChangeStateRefused,
      LeaseNotLapsed,
      ChangeInOtherProject,
      IdempotencyConflict,
    ]),
  ),
  submission: exitCodec(SubmissionStatus, ChangeNotFound),
  workspace: exitCodec(ChangeWorkspace, PrecheckRefusal),
  precheckStarted: exitCodec(Change, PrecheckRefusal),
  effectsDerived: exitCodec(Change, PrecheckRefusal),
  precheckRefused: exitCodec(
    Schema.Struct({ change: Change, verdictId: VerdictId }),
    PrecheckRefusal,
  ),
  planCompiled: exitCodec(Change, Schema.Union([ChangeNotFound, ChangeStateRefused])),
  tellPreview: exitCodec(Schema.Void, Schema.Never),
};

/**
 * The Change DO (`change:<ULID>`): intent revisions, premises, effects and
 * verdicts. Arguments are the encoded forms of the matching use-case inputs.
 */
export interface ChangeRpc extends EventReceiverRpc {
  get(): Promise<ExitJson>;
  declare(command: typeof DeclareCommand.Encoded): Promise<ExitJson>;
  revise(command: typeof ReviseCommand.Encoded): Promise<ExitJson>;
  /** Adds one premise under the lease; the premise's subject and its ancestors hear the change from then on. */
  rely(command: typeof RelyCommand.Encoded): Promise<ExitJson>;
  distinguish(command: typeof DistinguishCommand.Encoded): Promise<ExitJson>;
  /** The preflight of the change's intent as it stands, for an agent of its project; commits nothing. */
  nearby(command: typeof NearbyCommand.Encoded): Promise<ExitJson>;
  submit(command: typeof SubmitCommand.Encoded): Promise<ExitJson>;
  /** Puts trunk's head on the workspace's keel/trunk and moves the change's base there. */
  rebase(command: typeof RebaseCommand.Encoded): Promise<ExitJson>;
  /** Commits edits in the workspace under the lease: one commit on the head, never trunk. */
  commit(command: typeof CommitCommand.Encoded): Promise<ExitJson>;
  /** A fresh token for the workspace the change holds, for its own agent under its lease. */
  refreshWorkspace(command: typeof RefreshCommand.Encoded): Promise<ExitJson>;
  abandon(command: typeof AbandonCommand.Encoded): Promise<ExitJson>;
  adopt(command: typeof AdoptCommand.Encoded): Promise<ExitJson>;
  /**
   * The change once its submission state moves, or as it stands after
   * `waitMs` (0–30,000). An in-DO waiter with a setTimeout deadline; no polling.
   */
  submission(waitMs: number): Promise<ExitJson>;
  /**
   * For a Probe Workflow: the change and its project when it is terminal or
   * holds a current submission; otherwise `{waiting: true}`, with the
   * subscriber subscribed once, in the same transaction, to its next
   * ChangeSubmitted, ChangeWithdrawn or ChangeSuperseded.
   */
  awaitSubmission(command: typeof AwaitSubmissionCommand.Encoded): Promise<ExitJson>;
  /**
   * For KeelWorldCheck: the change and its project unless its Precheck is
   * still to answer (it is submitted or deriving); then `{waiting: true}`,
   * with the subscriber subscribed once, in the same transaction, to its
   * next PlanCompiled, ChangeDrifted, ChangeBounced, ChangeWithdrawn or
   * ChangeSuperseded.
   */
  awaitPlan(command: typeof AwaitPlanCommand.Encoded): Promise<ExitJson>;
  /** The change's workspace, base and project, for Precheck's diff. ChangeStateRefused when it holds no workspace. */
  workspace(): Promise<ExitJson>;
  precheckStarted(command: typeof PrecheckStartedCommand.Encoded): Promise<ExitJson>;
  effectsDerived(command: typeof EffectsDerivedCommand.Encoded): Promise<ExitJson>;
  precheckRefused(command: typeof PrecheckRefusedCommand.Encoded): Promise<ExitJson>;
  planCompiled(command: typeof PlanCompiledCommand.Encoded): Promise<ExitJson>;
  /** Tells the change where its candidate's preview answers, committing PreviewDeployed once. */
  tellPreview(command: typeof TellPreviewCommand.Encoded): Promise<ExitJson>;
}
