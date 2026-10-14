import {
  Change,
  ChangeState,
  ParkReason,
  Proposition,
  SubjectKey,
} from "@keeltown/core/domain/coordination";
import { Decision, DecisionNotFound, EscalationState } from "@keeltown/core/domain/memory";
import {
  Conflict,
  ConflictEscalated,
  ConflictNotFound,
  ConflictProven,
  ConflictState,
  DraftFailure,
  Escalation,
  EscalationNotFound,
  Probe,
  ProbeNotFound,
  ProbeOutcome,
  VerdictNotFound,
  World,
  WorldCheck,
  WorldCheckRan,
} from "@keeltown/core/domain/verification";
import {
  AgentId,
  ChangeId,
  CommitSha,
  ConflictId,
  DecisionId,
  EscalationId,
  EventEnvelope,
  GuardId,
  InstantSchema,
  NextAction,
  NamespaceId,
  ProbeId,
  ProjectId,
  SubjectId,
  UserId,
  VerdictId,
} from "@keeltown/core/kernel";
import { IndexedVerdict } from "@keeltown/core/ports";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";
import { EscalationRecord } from "./namespace.ts";

/** A feed position: twelve digits, so positions sort as strings. */
const Position = Schema.String.check(Schema.isPattern(/^\d{12}$/));

/**
 * Read the feed after `cursor` (from its start when absent): at most `limit`
 * (1–500, default 100) events, waiting up to `waitMs` (0–30,000) for one.
 * With `project`, only that project's events, sought through its index.
 * The cursor `end` is the feed's head in the turn that reads: no events and
 * the head's position, or with a wait the next arrival.
 */
export const ProjectorRead = Schema.Struct({
  cursor: Schema.optional(Schema.Union([Position, Schema.Literal("end")])),
  limit: Schema.optional(Schema.Int),
  waitMs: Schema.optional(Schema.Int),
  project: Schema.optional(ProjectId),
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

/** One change as the Projector folded it, and when it landed once that is heard (the port's `ChangeView`). */
export const ChangeView = Schema.Struct({
  change: Change,
  landedAt: Schema.optional(InstantSchema),
});

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
  escalation: Schema.optional(Escalation),
  chosen: Schema.optional(Schema.Struct({ option: Schema.String, summary: Schema.String })),
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

export const ProbeConflictRead = Schema.Struct({ project: ProjectId, probeId: ProbeId });

/**
 * A reader's escalations, newest first (the port's `EscalationListRead`): an
 * agent's are its project's; a person's are those asked of them, and of the
 * namespaces they maintain once the maintainers' turn has come by `now`.
 */
export const EscalationsRead = Schema.Struct({
  reader: Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("Project"), project: ProjectId }),
    Schema.Struct({
      _tag: Schema.Literal("User"),
      userId: UserId,
      maintains: Schema.Array(NamespaceId),
    }),
  ]),
  now: InstantSchema,
  state: Schema.optional(EscalationState),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
});

/** An escalation as the Projector reads it: the record, with its `E-n` (the port's `LabelledEscalation`). */
export const LabelledEscalation = Schema.Struct({
  ...EscalationRecord.fields,
  label: Schema.String,
});

export const EscalationPage = Schema.Struct({
  items: Schema.Array(LabelledEscalation),
  nextCursor: Schema.optional(Schema.String),
});

export const EscalationRead = Schema.Struct({ escalationId: EscalationId });

/** A decision as the Projector's index reads it, joined to its conflict (the port's `IndexedDecision`). */
export const IndexedDecision = Schema.Struct({
  decision: Decision,
  label: Schema.String,
  project: ProjectId,
  conflictId: Schema.optional(ConflictId),
  subjectId: Schema.optional(SubjectId),
  subjectKey: Schema.optional(SubjectKey),
  holds: Schema.Array(Proposition),
  against: Schema.optional(Schema.Array(ChangeId)),
  guards: Schema.Array(GuardId),
});

export const DecisionPage = Schema.Struct({
  items: Schema.Array(IndexedDecision),
  nextCursor: Schema.optional(Schema.String),
});

export const DecisionRead = Schema.Struct({ decisionId: DecisionId });

export const VerdictRead = Schema.Struct({ verdictId: VerdictId });

export const DecisionsRead = Schema.Struct({
  project: ProjectId,
  subject: Schema.optional(SubjectKey),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
});

export const GuardDecisionsRead = Schema.Struct({
  project: ProjectId,
  guardIds: Schema.Array(GuardId),
});

export const SubjectDecisionsRead = Schema.Struct({
  project: ProjectId,
  subjects: Schema.Array(SubjectKey),
});

/** A repository-relative path, as a subject's anchors name it. */
export const PathDecisionsRead = Schema.Struct({ project: ProjectId, path: Schema.String });

/** What `why` asks about (the port's `WhyTarget`): a subject, or a path. A line narrows nothing, so none is sent. */
export const WhyRead = Schema.Struct({
  project: ProjectId,
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("subject"), subject: SubjectKey }),
    Schema.Struct({ kind: Schema.Literal("path"), path: Schema.String }),
  ]),
});

/** One decision with what its chain is read from: its conflict and the changes it names, as folded (the port's `WhySource`). */
export const WhySource = Schema.Struct({
  decision: IndexedDecision,
  conflict: Schema.optional(ConflictRecord),
  changes: Schema.Array(ChangeView),
});

export const ProjectorCodecs = {
  nudge: exitCodec(Schema.Struct({ drained: Schema.Int }), Schema.Never),
  read: exitCodec(FeedPage, Schema.Never),
  changes: exitCodec(ChangePage, Schema.Never),
  snapshot: exitCodec(ViewSnapshot, Schema.Never),
  conflicts: exitCodec(ConflictPage, Schema.Never),
  conflict: exitCodec(ConflictRecord, ConflictNotFound),
  probeConflict: exitCodec(ConflictRecord, ProbeNotFound),
  escalations: exitCodec(EscalationPage, Schema.Never),
  escalation: exitCodec(LabelledEscalation, EscalationNotFound),
  decision: exitCodec(IndexedDecision, DecisionNotFound),
  verdict: exitCodec(IndexedVerdict, VerdictNotFound),
  decisions: exitCodec(DecisionPage, Schema.Never),
  guardDecisions: exitCodec(
    Schema.Array(Schema.Struct({ guardId: GuardId, decision: IndexedDecision })),
    Schema.Never,
  ),
  subjectDecisions: exitCodec(Schema.Array(IndexedDecision), Schema.Never),
  pathDecisions: exitCodec(Schema.Array(IndexedDecision), Schema.Never),
  explaining: exitCodec(Schema.Array(WhySource), Schema.Never),
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
  /** The conflict a probe of a project belongs to, as `conflict` answers it. ProbeNotFound when the project's feed has no such probe. */
  probeConflict(request: typeof ProbeConflictRead.Encoded): Promise<ExitJson>;
  /** A reader's escalations, newest first, by the list's own rule of who is asked when. */
  escalations(request: typeof EscalationsRead.Encoded): Promise<ExitJson>;
  /** One escalation with its place. EscalationNotFound for one the feed has not heard raised. */
  escalation(request: typeof EscalationRead.Encoded): Promise<ExitJson>;
  /** One decision, joined to its conflict. DecisionNotFound for one the index has not heard recorded. */
  decision(request: typeof DecisionRead.Encoded): Promise<ExitJson>;
  /** A project's decisions, newest first, on one subject when asked. */
  decisions(request: typeof DecisionsRead.Encoded): Promise<ExitJson>;
  /** The decision each of a project's guards holds; a guard that holds none is left out. */
  guardDecisions(request: typeof GuardDecisionsRead.Encoded): Promise<ExitJson>;
  /** A project's decisions on any of these subjects, newest first. */
  subjectDecisions(request: typeof SubjectDecisionsRead.Encoded): Promise<ExitJson>;
  /** A project's decisions on the subjects anchored at a path, newest first. */
  pathDecisions(request: typeof PathDecisionsRead.Encoded): Promise<ExitJson>;
  /** A project's active decisions on a subject or at a path, newest first, each with its conflict and the changes it names, in one read. */
  explaining(request: typeof WhyRead.Encoded): Promise<ExitJson>;
  /** One verdict, by its id alone. VerdictNotFound for one the feed does not hold. */
  verdict(request: typeof VerdictRead.Encoded): Promise<ExitJson>;
}
