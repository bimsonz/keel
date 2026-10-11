import {
  Change,
  ChangeInOtherProject,
  ChangeNotFound,
  ChangeOrigin,
  ChangeStateRefused,
  CommitNotInWorkspace,
  FootprintEntry,
  LeaseNotLapsed,
  LeaseStale,
  PoolExhausted,
  Preflight,
  Proposition,
  RevisionMismatch,
  SketchNotFound,
} from "@keeltown/core/domain/coordination";
import { IdempotencyConflict } from "@keeltown/core/domain/identity";
import { PushRejected } from "@keeltown/core/domain/integration";
import { PackTooLarge } from "./trunk.ts";
import {
  AgentId,
  ChangeId,
  CommitSha,
  ConflictId,
  ContentHash,
  LeaseId,
  NextAction,
  ProjectId,
  SketchId,
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
  projectId: ProjectId,
  /** Absent means `agent`; the Auditor's revert declares through a platform path. */
  origin: ChangeOrigin.pipe(Schema.withDecodingDefaultKey(Effect.succeed("agent" as const))),
  goal: Schema.NonEmptyString,
  footprint: Schema.Array(FootprintEntry),
  premises: Schema.Array(Proposition),
  declaredEffects: Schema.optional(Schema.Array(Proposition)),
  sketchId: Schema.optional(SketchId),
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});
export type DeclareCommand = typeof DeclareCommand.Type;

/** Submit a commit for a change. The lease is authorised in the DO alone; the key is the commit's cause. */
export const SubmitCommand = Schema.Struct({
  agentId: AgentId,
  leaseId: LeaseId,
  commitSha: CommitSha,
  idempotencyKey: Schema.String,
});
export type SubmitCommand = typeof SubmitCommand.Type;

/** Move a change onto trunk's head under its lease, after a textual bounce. */
export const RebaseCommand = Schema.Struct({
  agentId: AgentId,
  leaseId: LeaseId,
  idempotencyKey: Schema.String,
});
export type RebaseCommand = typeof RebaseCommand.Type;

/** Revise a change's intent under its lease. `ifMatchRevision` is the revision the caller last read (If-Match). */
export const ReviseCommand = Schema.Struct({
  agentId: AgentId,
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
  leaseId: LeaseId,
  premise: Proposition,
  idempotencyKey: Schema.String,
});
export type RelyCommand = typeof RelyCommand.Type;

/** Read what is near a change. `projectId` is the reader's, from its token: a change in another project is ChangeInOtherProject. */
export const NearbyCommand = Schema.Struct({ projectId: ProjectId });
export type NearbyCommand = typeof NearbyCommand.Type;

/** Who may withdraw a change: the holder of its lease, or an operator (a parked change, say). */
export const WithdrawAuthority = Schema.Union([
  Schema.TaggedStruct("Lease", { leaseId: LeaseId }),
  Schema.TaggedStruct("Operator", { by: Schema.String }),
]);
export type WithdrawAuthority = typeof WithdrawAuthority.Type;

/** Withdraw a change. */
export const AbandonCommand = Schema.Struct({
  agentId: AgentId,
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
 * walk can stop there); and the project whose settings hold `protectedPaths`.
 */
export const ChangeWorkspace = Schema.Struct({
  workspaceId: WorkspaceId,
  repo: RepoRef,
  baseSha: CommitSha,
  grantedSha: CommitSha,
  projectId: ProjectId,
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

/** Precheck passed and compiled the change's Verification Plan: commits PlanCompiled. */
export const PlanCompiledCommand = Schema.Struct({
  revision: Schema.Int,
  instanceId: Schema.NonEmptyString,
  planHash: ContentHash,
  steps: Schema.Int,
  costEstimate: Schema.Number,
});
export type PlanCompiledCommand = typeof PlanCompiledCommand.Type;

const PrecheckRefusal = Schema.Union([ChangeNotFound, ChangeStateRefused]);

// A reused Idempotency-Key with another body is IdempotencyConflict on every keyed call.
const Mutation = Schema.Union([
  ChangeNotFound,
  LeaseStale,
  RevisionMismatch,
  ChangeStateRefused,
  IdempotencyConflict,
]);

export const ChangeCodecs = {
  get: exitCodec(Change, ChangeNotFound),
  declare: exitCodec(
    Schema.Struct({ change: Change, preflight: Preflight, grant: WorkspaceGrant }),
    Schema.Union([ChangeStateRefused, PoolExhausted, SketchNotFound, IdempotencyConflict]),
  ),
  revise: exitCodec(Schema.Struct({ change: Change, preflight: Preflight }), Mutation),
  // A rely names no revision: RevisionMismatch belongs to revise alone.
  rely: exitCodec(
    Schema.Struct({ change: Change, preflight: Preflight }),
    Schema.Union([ChangeNotFound, LeaseStale, ChangeStateRefused, IdempotencyConflict]),
  ),
  nearby: exitCodec(Preflight, Schema.Union([ChangeNotFound, ChangeInOtherProject])),
  // Submit carries no revision: RevisionMismatch belongs to revise alone.
  submit: exitCodec(
    Change,
    Schema.Union([
      ChangeNotFound,
      LeaseStale,
      ChangeStateRefused,
      CommitNotInWorkspace,
      IdempotencyConflict,
    ]),
  ),
  // Nor does abandon.
  abandon: exitCodec(
    Change,
    Schema.Union([ChangeNotFound, LeaseStale, ChangeStateRefused, IdempotencyConflict]),
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
      LeaseStale,
      ChangeStateRefused,
      IdempotencyConflict,
      PushRejected,
      PackTooLarge,
    ]),
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
  precheckRefused: exitCodec(
    Schema.Struct({ change: Change, verdictId: VerdictId }),
    PrecheckRefusal,
  ),
  planCompiled: exitCodec(Change, PrecheckRefusal),
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
  /** The preflight of the change's intent as it stands, for an agent of its project; commits nothing. */
  nearby(command: typeof NearbyCommand.Encoded): Promise<ExitJson>;
  submit(command: typeof SubmitCommand.Encoded): Promise<ExitJson>;
  /** Puts trunk's head on the workspace's keel/trunk and moves the change's base there. */
  rebase(command: typeof RebaseCommand.Encoded): Promise<ExitJson>;
  abandon(command: typeof AbandonCommand.Encoded): Promise<ExitJson>;
  adopt(command: typeof AdoptCommand.Encoded): Promise<ExitJson>;
  /**
   * The change once its submission state moves, or as it stands after
   * `waitMs` (0–30,000). An in-DO waiter with a setTimeout deadline; no polling.
   */
  submission(waitMs: number): Promise<ExitJson>;
  /** The change's workspace, base and project, for Precheck's diff. ChangeStateRefused when it holds no workspace. */
  workspace(): Promise<ExitJson>;
  precheckStarted(command: typeof PrecheckStartedCommand.Encoded): Promise<ExitJson>;
  precheckRefused(command: typeof PrecheckRefusedCommand.Encoded): Promise<ExitJson>;
  planCompiled(command: typeof PlanCompiledCommand.Encoded): Promise<ExitJson>;
}
