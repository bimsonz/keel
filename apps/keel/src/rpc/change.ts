import {
  Change,
  ChangeNotFound,
  ChangeStateRefused,
  CommitNotInWorkspace,
  LeaseStale,
  Preflight,
  RevisionMismatch,
} from "@keeltown/core/domain/coordination";
import { CommitSha } from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";

/** A change's submission as it stands: the change, and the commit last submitted for it. */
export const SubmissionStatus = Schema.Struct({
  change: Change,
  commitSha: Schema.NullOr(CommitSha),
});

const Mutation = Schema.Union([ChangeNotFound, LeaseStale, RevisionMismatch, ChangeStateRefused]);

export const ChangeCodecs = {
  get: exitCodec(Change, ChangeNotFound),
  declare: exitCodec(Schema.Struct({ change: Change, preflight: Preflight }), ChangeStateRefused),
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
  declare(command: unknown): Promise<ExitJson>;
  revise(command: unknown): Promise<ExitJson>;
  submit(command: unknown): Promise<ExitJson>;
  abandon(command: unknown): Promise<ExitJson>;
  adopt(command: unknown): Promise<ExitJson>;
  /**
   * The change once its submission state moves, or as it stands after
   * `waitMs` (0–30,000). An in-DO waiter with a setTimeout deadline; no polling.
   */
  submission(waitMs: number): Promise<ExitJson>;
}
