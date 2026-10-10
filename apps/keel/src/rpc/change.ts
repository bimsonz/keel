import {
  Change,
  ChangeNotFound,
  ChangeOrigin,
  ChangeStateRefused,
  CommitNotInWorkspace,
  FootprintEntry,
  LeaseStale,
  PoolExhausted,
  Preflight,
  Proposition,
  RevisionMismatch,
  SketchNotFound,
} from "@keeltown/core/domain/coordination";
import {
  AgentId,
  ChangeId,
  CommitSha,
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

/** Adopt a change whose lease has lapsed: `agentId` takes a new lease, which fences the old token. */
export const AdoptCommand = Schema.Struct({
  agentId: AgentId,
  idempotencyKey: Schema.String,
});
export type AdoptCommand = typeof AdoptCommand.Type;

/** A change's submission as it stands: the change, and the commit last submitted for it. */
export const SubmissionStatus = Schema.Struct({
  change: Change,
  commitSha: Schema.NullOr(CommitSha),
});

/**
 * Where Precheck diffs a change: its workspace repo, the base it was granted
 * at (`WorkspaceGranted.baseSha`, so a mirror that lags trunk never loses the
 * base), and the project whose settings hold `protectedPaths`.
 */
export const ChangeWorkspace = Schema.Struct({
  workspaceId: WorkspaceId,
  repo: RepoRef,
  baseSha: CommitSha,
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

const Mutation = Schema.Union([ChangeNotFound, LeaseStale, RevisionMismatch, ChangeStateRefused]);

export const ChangeCodecs = {
  get: exitCodec(Change, ChangeNotFound),
  declare: exitCodec(
    Schema.Struct({ change: Change, preflight: Preflight, grant: WorkspaceGrant }),
    Schema.Union([ChangeStateRefused, PoolExhausted, SketchNotFound]),
  ),
  revise: exitCodec(Schema.Struct({ change: Change, preflight: Preflight }), Mutation),
  // Submit carries no revision: RevisionMismatch belongs to revise alone.
  submit: exitCodec(
    Change,
    Schema.Union([ChangeNotFound, LeaseStale, ChangeStateRefused, CommitNotInWorkspace]),
  ),
  abandon: exitCodec(Change, Mutation),
  adopt: exitCodec(Change, Schema.Union([ChangeNotFound, ChangeStateRefused])),
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
  submit(command: typeof SubmitCommand.Encoded): Promise<ExitJson>;
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
