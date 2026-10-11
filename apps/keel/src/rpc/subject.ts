import { Conflict, ConflictNotFound, MoveRefused } from "@keeltown/core/domain/verification";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";

export const SubjectCodecs = {
  conflict: exitCodec(Conflict, ConflictNotFound),
  resolve: exitCodec(Conflict, Schema.Union([ConflictNotFound, MoveRefused])),
};

/**
 * The Subject DO (`subj:<project>:<key>`): premises, tenets, decisions, fallout, semantic and precedent conflicts.
 * A change relies on a subject through its own Change DO, which subscribes the subject; there is no rely here.
 */
export interface SubjectRpc extends EventReceiverRpc {
  conflict(conflictId: string): Promise<ExitJson>;
  resolve(command: unknown): Promise<ExitJson>;
}
