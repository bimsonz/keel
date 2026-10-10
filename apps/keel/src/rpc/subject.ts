import { Proposition } from "@keeltown/core/domain/coordination";
import { Conflict, ConflictNotFound, MoveRefused } from "@keeltown/core/domain/verification";
import type { ChangeId } from "@keeltown/core/kernel";
import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

export const SubjectCodecs = {
  rely: exitCodec(Schema.Struct({ contradictions: Schema.Array(Proposition) }), Schema.Never),
  conflict: exitCodec(Conflict, ConflictNotFound),
  resolve: exitCodec(Conflict, Schema.Union([ConflictNotFound, MoveRefused])),
};

/** The Subject DO (`subj:<project>:<key>`): premises, tenets, decisions, fallout, semantic and precedent conflicts. */
export interface SubjectRpc {
  rely(changeId: typeof ChangeId.Encoded, premise: typeof Proposition.Encoded): Promise<ExitJson>;
  conflict(conflictId: string): Promise<ExitJson>;
  resolve(command: unknown): Promise<ExitJson>;
}
