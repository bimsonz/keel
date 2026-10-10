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
import { AgentId, ChangeId, CommitSha, LeaseId, ProjectId, SketchId } from "@keeltown/core/kernel";
import { Effect, Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";
import { WorkspaceGrant } from "./workspace-pool.ts";

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

/** A change's submission as it stands: the change, and the commit last submitted for it. */
export const SubmissionStatus = Schema.Struct({
  change: Change,
  commitSha: Schema.NullOr(CommitSha),
});

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
};

/**
 * The Change DO (`change:<ULID>`): intent revisions, premises, effects and
 * verdicts. Arguments are the encoded forms of the matching use-case inputs.
 */
export interface ChangeRpc extends EventReceiverRpc {
  get(): Promise<ExitJson>;
  declare(command: typeof DeclareCommand.Encoded): Promise<ExitJson>;
  revise(command: unknown): Promise<ExitJson>;
  submit(command: typeof SubmitCommand.Encoded): Promise<ExitJson>;
  abandon(command: unknown): Promise<ExitJson>;
  adopt(command: unknown): Promise<ExitJson>;
  /**
   * The change once its submission state moves, or as it stands after
   * `waitMs` (0–30,000). An in-DO waiter with a setTimeout deadline; no polling.
   */
  submission(waitMs: number): Promise<ExitJson>;
}
