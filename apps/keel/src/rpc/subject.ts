import { IdempotencyConflict } from "@keeltown/core/domain/identity";
import {
  DraftFailure,
  Conflict,
  ConflictNotFound,
  ConflictStateRefused,
  MoveRefused,
  Probe,
  ProbeNotFound,
  ProbeOutcome,
  ProbeStateRefused,
  World,
} from "@keeltown/core/domain/verification";
import { Move } from "@keeltown/core/domain/coordination";
import {
  AgentId,
  ChangeId,
  ConflictId,
  ContentHash,
  ProbeId,
  RunRef,
  UserId,
} from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";

/** A conflict, and the probe drafted for it when there is one (core's `ConflictView`). */
export const ConflictView = Schema.Struct({ conflict: Conflict, probe: Schema.optional(Probe) });

// The Probe Workflow's facts. Each goes through the domain's conflict and
// probe machines, which fence it, and each is idempotent per (conflict or
// probe, world, run): a replayed Workflow step answers the conflict as it stands.

/** A probe was drafted for the suspected conflict (core's `DraftedProbe`). */
export const ProbeDraftedCommand = Schema.Struct({
  conflictId: ConflictId,
  attempts: Schema.Int,
  bundleHash: ContentHash,
});

/** Drafting ended without a probe to calibrate (core's `FailedDraft`). */
export const ProbeDraftFailedCommand = Schema.Struct({
  conflictId: ConflictId,
  attempts: Schema.Int,
  reason: DraftFailure,
});

/** One world-matrix cell of the conflict's probe (core's `ProbeCell`). */
export const ProbeCellRanCommand = Schema.Struct({
  conflictId: ConflictId,
  probeId: ProbeId,
  world: World,
  run: Schema.Int,
  outcome: ProbeOutcome,
  resultRef: Schema.String,
});

/** One check of a party's suite in one world while the conflict probes (core's `WorldCheckCell`). */
export const WorldCheckRanCommand = Schema.Struct({
  conflictId: ConflictId,
  world: World,
  check: Schema.String,
  run: Schema.Int,
  outcome: ProbeOutcome,
  counts: Schema.optional(
    Schema.Struct({ passed: Schema.Int, failed: Schema.Int, skipped: Schema.Int }),
  ),
  reason: Schema.optional(Schema.String),
});

/** A party's move on a conflict (core's `ResolveCommand`): the doorway has checked the party's lease. */
export const ResolveCommand = Schema.Struct({
  conflictId: ConflictId,
  changeId: ChangeId,
  agentId: AgentId,
  run: Schema.optional(RunRef),
  sponsor: Schema.optional(UserId),
  move: Move,
  note: Schema.optional(Schema.String),
  idempotencyKey: Schema.String,
});

const LedgerRefusal = Schema.Union([
  ConflictNotFound,
  ConflictStateRefused,
  ProbeNotFound,
  ProbeStateRefused,
  IdempotencyConflict,
]);

export const SubjectCodecs = {
  conflict: exitCodec(ConflictView, ConflictNotFound),
  resolve: exitCodec(
    ConflictView,
    Schema.Union([ConflictNotFound, MoveRefused, IdempotencyConflict]),
  ),
  probeDrafted: exitCodec(ConflictView, LedgerRefusal),
  probeDraftFailed: exitCodec(ConflictView, LedgerRefusal),
  probeRunFailed: exitCodec(ConflictView, LedgerRefusal),
  probeCellRan: exitCodec(ConflictView, LedgerRefusal),
  worldCheckRan: exitCodec(ConflictView, LedgerRefusal),
};

/**
 * The Subject DO (`subj:<project>:<key>`): premises, tenets, decisions, fallout, semantic and precedent conflicts,
 * and each conflict's probe. A change relies on a subject through its own Change DO, which subscribes the subject;
 * there is no rely here. The Probe Workflow reports its facts through the five probe methods; a probe that
 * leaves its conflict unprovable has the subject raise an escalation in the project's namespace before the method answers.
 */
export interface SubjectRpc extends EventReceiverRpc {
  conflict(conflictId: string): Promise<ExitJson>;
  /** A party's move. `escalate` puts a proven conflict to a person, once; every other move is MoveRefused until it is built. */
  resolve(command: typeof ResolveCommand.Encoded): Promise<ExitJson>;
  probeDrafted(command: typeof ProbeDraftedCommand.Encoded): Promise<ExitJson>;
  probeDraftFailed(command: typeof ProbeDraftFailedCommand.Encoded): Promise<ExitJson>;
  /** The drafted probe's run ended before its matrix was complete. */
  probeRunFailed(conflictId: string): Promise<ExitJson>;
  probeCellRan(command: typeof ProbeCellRanCommand.Encoded): Promise<ExitJson>;
  worldCheckRan(command: typeof WorldCheckRanCommand.Encoded): Promise<ExitJson>;
}
