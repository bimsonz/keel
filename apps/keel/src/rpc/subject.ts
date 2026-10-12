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
import { ConflictId, ContentHash, ProbeId } from "@keeltown/core/kernel";
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

const LedgerRefusal = Schema.Union([
  ConflictNotFound,
  ConflictStateRefused,
  ProbeNotFound,
  ProbeStateRefused,
  IdempotencyConflict,
]);

export const SubjectCodecs = {
  conflict: exitCodec(ConflictView, ConflictNotFound),
  resolve: exitCodec(Conflict, Schema.Union([ConflictNotFound, MoveRefused])),
  probeDrafted: exitCodec(ConflictView, LedgerRefusal),
  probeDraftFailed: exitCodec(ConflictView, LedgerRefusal),
  probeCellRan: exitCodec(ConflictView, LedgerRefusal),
  worldCheckRan: exitCodec(ConflictView, LedgerRefusal),
};

/**
 * The Subject DO (`subj:<project>:<key>`): premises, tenets, decisions, fallout, semantic and precedent conflicts,
 * and each conflict's probe. A change relies on a subject through its own Change DO, which subscribes the subject;
 * there is no rely here. The Probe Workflow reports its facts through the four probe methods.
 */
export interface SubjectRpc extends EventReceiverRpc {
  conflict(conflictId: string): Promise<ExitJson>;
  resolve(command: unknown): Promise<ExitJson>;
  probeDrafted(command: typeof ProbeDraftedCommand.Encoded): Promise<ExitJson>;
  probeDraftFailed(command: typeof ProbeDraftFailedCommand.Encoded): Promise<ExitJson>;
  probeCellRan(command: typeof ProbeCellRanCommand.Encoded): Promise<ExitJson>;
  worldCheckRan(command: typeof WorldCheckRanCommand.Encoded): Promise<ExitJson>;
}
