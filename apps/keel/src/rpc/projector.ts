import { ChangeState, ParkReason } from "@keeltown/core/domain/coordination";
import {
  Conflict,
  ConflictEscalated,
  ConflictNotFound,
  ConflictProven,
  ConflictState,
  DraftFailure,
  Probe,
  ProbeOutcome,
  World,
  WorldCheck,
  WorldCheckRan,
} from "@keeltown/core/domain/verification";
import {
  AgentId,
  ChangeId,
  CommitSha,
  ConflictId,
  EventEnvelope,
  GuardId,
  InstantSchema,
  NextAction,
  ProbeId,
  ProjectId,
} from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";

/** A feed position: twelve digits, so positions sort as strings. */
const Position = Schema.String.check(Schema.isPattern(/^\d{12}$/));

/** Read the feed after `cursor` (from its start when absent): at most `limit` (1–500, default 100) events, waiting up to `waitMs` (0–30,000) for one. */
export const ProjectorRead = Schema.Struct({
  cursor: Schema.optional(Position),
  limit: Schema.optional(Schema.Int),
  waitMs: Schema.optional(Schema.Int),
});

/**
 * One feed entry: the event, and the short label the Projector gave it when it
 * creates something the console names (`#n` changes, `D-n` decisions, `G-n`
 * guards, `C-n` conflicts, `E-n` escalations, `P-n` probes), numbered per project.
 */
export const FeedEntry = Schema.Struct({
  ...EventEnvelope.fields,
  label: Schema.optional(Schema.String),
});

/** A page of the feed: the events after the cursor read, and the cursor to read on from. */
export const FeedPage = Schema.Struct({
  events: Schema.Array(FeedEntry),
  cursor: Position,
});

/** One change as the console lists it: `#number`, its state, goal and agent. */
export const ChangeSummary = Schema.Struct({
  changeId: ChangeId,
  number: Schema.Int,
  state: ChangeState,
  parkReason: Schema.optional(ParkReason),
  agentId: AgentId,
  goal: Schema.String,
  revision: Schema.Int,
  declaredAt: InstantSchema,
  updatedAt: InstantSchema,
});

/** Trunk's head and height: TrunkInitialized is height 0, and each advance adds 1. */
export const TrunkView = Schema.Struct({ head: CommitSha, height: Schema.Int });

/** A project's changes, newest `#n` first: in one `state` when given, numbered below `cursor`, at most `limit` (1–100, default 50). */
export const ChangesRead = Schema.Struct({
  project: ProjectId,
  state: Schema.optional(ChangeState),
  cursor: Schema.optional(Schema.Int),
  limit: Schema.optional(Schema.Int),
});

/** A page of a project's changes; `nextCursor` is the last number returned when more remain. */
export const ChangePage = Schema.Struct({
  items: Schema.Array(ChangeSummary),
  nextCursor: Schema.optional(Schema.Int),
});

/** A project's changes and trunk at the feed's head, and that head as the cursor to fold forward from. */
export const ViewSnapshot = Schema.Struct({
  cursor: Position,
  changes: Schema.Array(ChangeSummary),
  trunk: Schema.optional(TrunkView),
});

export const SnapshotRead = Schema.Struct({ project: ProjectId });

/**
 * A conflict as the Projector folded it from its own events (the port's
 * `ConflictRecord`): the domain's Conflict and Probe, each probe run and suite
 * run as its event gave it, the guard, how it was proven or dismissed, its
 * labels, and what each party was told.
 */
export const ConflictRecord = Schema.Struct({
  conflict: Conflict,
  probe: Schema.optional(Probe),
  runs: Schema.Array(
    Schema.Struct({
      world: World,
      run: Schema.Int,
      outcome: ProbeOutcome,
      resultRef: Schema.String,
      at: InstantSchema,
    }),
  ),
  checks: Schema.Array(
    Schema.Struct({
      world: World,
      check: WorldCheck,
      run: Schema.Int,
      outcome: ProbeOutcome,
      counts: Schema.optional(WorldCheckRan.fields.counts),
      reason: Schema.optional(Schema.String),
      at: InstantSchema,
    }),
  ),
  guard: Schema.optional(
    Schema.Struct({
      id: GuardId,
      probeId: ProbeId,
      runs: Schema.Int,
      admittedAt: InstantSchema,
      retiredAt: Schema.optional(InstantSchema),
    }),
  ),
  draftFailure: Schema.optional(DraftFailure),
  proven: Schema.optional(ConflictProven.fields.evidence),
  dismissed: Schema.optional(Schema.String),
  escalated: Schema.optional(ConflictEscalated.fields.reason),
  settledAt: Schema.optional(InstantSchema),
  number: Schema.Int,
  labels: Schema.Struct({
    conflict: Schema.String,
    probe: Schema.optional(Schema.String),
    guard: Schema.optional(Schema.String),
    escalation: Schema.optional(Schema.String),
    decision: Schema.optional(Schema.String),
  }),
  told: Schema.Array(
    Schema.Struct({
      changeId: ChangeId,
      how: Schema.Literals(["bounced", "noted"]),
      nextActions: Schema.Array(NextAction),
      at: InstantSchema,
    }),
  ),
});

/** A project's conflicts, newest `C-n` first: open or settled, in one `state`, of one change, numbered below `cursor`, at most `limit` (1–100, default 50). */
export const ConflictsRead = Schema.Struct({
  project: ProjectId,
  open: Schema.optional(Schema.Boolean),
  state: Schema.optional(ConflictState),
  changeId: Schema.optional(ChangeId),
  cursor: Schema.optional(Schema.Int),
  limit: Schema.optional(Schema.Int),
});

/** A page of a project's conflicts, and how many it has open and settled whatever the page holds. */
export const ConflictPage = Schema.Struct({
  items: Schema.Array(ConflictRecord),
  nextCursor: Schema.optional(Schema.Int),
  totals: Schema.Struct({ open: Schema.Int, settled: Schema.Int }),
});

export const ConflictRead = Schema.Struct({ project: ProjectId, conflictId: ConflictId });

export const ProjectorCodecs = {
  nudge: exitCodec(Schema.Struct({ drained: Schema.Int }), Schema.Never),
  read: exitCodec(FeedPage, Schema.Never),
  changes: exitCodec(ChangePage, Schema.Never),
  snapshot: exitCodec(ViewSnapshot, Schema.Never),
  conflicts: exitCodec(ConflictPage, Schema.Never),
  conflict: exitCodec(ConflictRecord, ConflictNotFound),
};

/**
 * The Projector DO (`projector`). At L1 every Keel object delivers every event
 * it commits here, and the Projector keeps them as one feed for the console.
 * Positions are arrival order: each emitter's events keep their commit order,
 * but there is no total causal order across emitters. It drains the operation
 * log into read models when nudged, then sleeps.
 */
export interface ProjectorRpc extends EventReceiverRpc {
  nudge(): Promise<ExitJson>;
  /** The events after `cursor`; with `waitMs` above 0 and none yet, the first page an arrival brings, or an empty one at the deadline. */
  read(request: typeof ProjectorRead.Encoded): Promise<ExitJson>;
  /** A project's changes as the console lists them (Mission Control's D6). */
  changes(request: typeof ChangesRead.Encoded): Promise<ExitJson>;
  /** A project's changes and trunk with the feed's head, read in one turn (Mission Control's D7). */
  snapshot(request: typeof SnapshotRead.Encoded): Promise<ExitJson>;
  /** A project's conflicts as the console lists them, with the open and settled totals. */
  conflicts(request: typeof ConflictsRead.Encoded): Promise<ExitJson>;
  /** One conflict of a project: its sides, probe, matrix cells and guard as folded. ConflictNotFound when the project's feed has none by that id. */
  conflict(request: typeof ConflictRead.Encoded): Promise<ExitJson>;
}
