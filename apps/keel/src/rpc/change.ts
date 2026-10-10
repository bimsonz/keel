import { Change, ChangeNotFound, ChangeStateRefused, LeaseStale, Preflight, RevisionMismatch } from "@keeltown/core/domain/coordination";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

const Mutation = Schema.Union([ChangeNotFound, LeaseStale, RevisionMismatch, ChangeStateRefused]);

export const ChangeCodecs = {
  get: exitCodec(Change, ChangeNotFound),
  declare: exitCodec(Schema.Struct({ change: Change, preflight: Preflight }), ChangeStateRefused),
  revise: exitCodec(Schema.Struct({ change: Change, preflight: Preflight }), Mutation),
  submit: exitCodec(Change, Mutation),
  abandon: exitCodec(Change, Mutation),
  adopt: exitCodec(Change, Schema.Union([ChangeNotFound, ChangeStateRefused])),
};

/**
 * The Change DO (`change:<ULID>`): intent revisions, premises, effects and
 * verdicts. Arguments are the encoded forms of the matching use-case inputs.
 */
export interface ChangeRpc {
  get(): Promise<ExitJson>;
  declare(command: unknown): Promise<ExitJson>;
  revise(command: unknown): Promise<ExitJson>;
  submit(command: unknown): Promise<ExitJson>;
  abandon(command: unknown): Promise<ExitJson>;
  adopt(command: unknown): Promise<ExitJson>;
}
