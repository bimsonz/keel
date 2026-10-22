import { Context, type Effect, Schema } from "effect";
import { Change, ChangeOrigin, ChangeState, ParkReason } from "../../domain/coordination/index.ts";
import {
  AgentId,
  ChangeId,
  CommandActor,
  CommitSha,
  type ConflictId,
  GuardId,
  InstantSchema,
  NextAction,
  ProbeId,
  ProjectId,
} from "../../domain/kernel/index.ts";
import {
  Conflict,
  Escalation,
  type ConflictNotFound,
  ConflictProven,
  type ConflictState,
  ConflictEscalated,
  DraftFailure,
  Probe,
  type ProbeNotFound,
  ProbeOutcome,
  World,
  WorldCheck,
  WorldCheckRan,
} from "../../domain/verification/index.ts";
import { DecisionChosen } from "./escalations.ts";

/** One change as the console lists it: `#number`, its state, goal and agent. */
export const ChangeSummary = Schema.Struct({
  changeId: ChangeId,
  number: Schema.Int,
  state: ChangeState,
  parkReason: Schema.optional(ParkReason),
  /** The agent holding it; absent on a proposal, which no agent holds. */
  agentId: Schema.optional(AgentId),
  /** Where it started; absent on a summary folded before origins were kept, which is an agent's. */
  origin: Schema.optional(ChangeOrigin),
  /** On a proposal alone: the fork it came from, the commit it carries, who proposed it and what was approved. */
  proposal: Schema.optional(
    Schema.Struct({
      fork: ProjectId,
      commit: CommitSha,
      proposer: CommandActor,
      approved: Schema.optional(CommitSha),
    }),
  ),
  goal: Schema.String,
  revision: Schema.Int,
  declaredAt: InstantSchema,
  updatedAt: InstantSchema,
});
export type ChangeSummary = typeof ChangeSummary.Type;

/**
 * One change as the Projector folded it: the domain's Change, and when it
 * landed, by its ChangeLanded event's own time, once the Projector has heard
 * it land. No other event on the change moves it.
 */
export const ChangeView = Schema.Struct({
  change: Change,
  landedAt: Schema.optional(InstantSchema),
});
export type ChangeView = typeof ChangeView.Type;

/** Trunk's head and height: TrunkInitialized is height 0, and each advance adds 1. */
export const TrunkView = Schema.Struct({ head: CommitSha, height: Schema.Int });
export type TrunkView = typeof TrunkView.Type;

export interface ChangeListRead {
  readonly project: ProjectId;
  readonly state?: ChangeState | undefined;
  /** The project's proposals alone: those still open, or those that landed or were closed. */
  readonly proposals?: "open" | "closed" | undefined;
  /** The last `#n` an earlier page returned: this page holds the changes numbered below it. */
  readonly cursor?: number | undefined;
  /** 1–100; absent is 50. */
  readonly limit?: number | undefined;
}

export interface ChangeListPage {
  readonly items: readonly ChangeSummary[];
  /** The last number returned, when changes remain after this page. */
  readonly nextCursor?: number | undefined;
}

/** A project's changes and trunk at the feed's head, and that head as the cursor to fold forward from. */
export interface ViewSnapshot {
  /** A feed position: `GET /v1/events?cursor=` from it returns only what the snapshot does not hold. */
  readonly cursor: string;
  readonly changes: readonly ChangeSummary[];
  /** Absent until the project's trunk is initialized. */
  readonly trunk?: TrunkView | undefined;
}

/** One run of a conflict's probe in one world: the domain's cell, with where its result is kept and when it ran. */
export const ProbeRunView = Schema.Struct({
  world: World,
  run: Schema.Int,
  outcome: ProbeOutcome,
  resultRef: Schema.String,
  at: InstantSchema,
});
export type ProbeRunView = typeof ProbeRunView.Type;

/** One run of a suite in one world of a conflict's matrix, as WorldCheckRan gave it, and when. */
export const WorldCheckView = Schema.Struct({
  world: World,
  check: WorldCheck,
  run: Schema.Int,
  outcome: ProbeOutcome,
  counts: Schema.optional(WorldCheckRan.fields.counts),
  reason: Schema.optional(Schema.String),
  at: InstantSchema,
});
export type WorldCheckView = typeof WorldCheckView.Type;

/** What Keel told one party about a conflict: its change was bounced over it, or the conflict was noted on it. */
export const ToldView = Schema.Struct({
  changeId: ChangeId,
  how: Schema.Literals(["bounced", "noted"]),
  nextActions: Schema.Array(NextAction),
  at: InstantSchema,
});
export type ToldView = typeof ToldView.Type;

/**
 * A conflict as the Projector folds it from its own events: the domain's
 * Conflict and Probe (so every state is the domain's word), and beside them
 * what those entities do not keep: each probe run's result and time, each
 * suite run's counts, reason and time, the guard, how it was proven or
 * dismissed, and when it settled.
 */
export const ConflictFolded = Schema.Struct({
  conflict: Conflict,
  probe: Schema.optional(Probe),
  runs: Schema.Array(ProbeRunView),
  checks: Schema.Array(WorldCheckView),
  guard: Schema.optional(
    Schema.Struct({
      id: GuardId,
      probeId: ProbeId,
      runs: Schema.Int,
      admittedAt: InstantSchema,
      retiredAt: Schema.optional(InstantSchema),
    }),
  ),
  /** Why the drafts failed, when the probe was discarded for that. */
  draftFailure: Schema.optional(DraftFailure),
  proven: Schema.optional(ConflictProven.fields.evidence),
  dismissed: Schema.optional(Schema.String),
  escalated: Schema.optional(ConflictEscalated.fields.reason),
  /** When it was dismissed or resolved. */
  settledAt: Schema.optional(InstantSchema),
});
export type ConflictFolded = typeof ConflictFolded.Type;

/**
 * A conflict as read: what was folded, the short labels the feed gave it and
 * what it led to (`C-n`, and `P-n`, `G-n`, `E-n`, `D-n` once each exists in
 * the project's feed), and what each party was told.
 */
export const ConflictRecord = Schema.Struct({
  ...ConflictFolded.fields,
  /** The `n` of `C-n`: the project's nth conflict. */
  number: Schema.Int,
  labels: Schema.Struct({
    conflict: Schema.String,
    probe: Schema.optional(Schema.String),
    guard: Schema.optional(Schema.String),
    escalation: Schema.optional(Schema.String),
    decision: Schema.optional(Schema.String),
  }),
  told: Schema.Array(ToldView),
  /** The question a person was asked about it, once the Projector has heard it raised. */
  escalation: Schema.optional(Escalation),
  /** What the ruling's decision chose, once the Projector has heard it recorded. */
  chosen: Schema.optional(DecisionChosen),
});
export type ConflictRecord = typeof ConflictRecord.Type;

export interface ConflictListRead {
  readonly project: ProjectId;
  /** Only open conflicts (true) or only settled ones (false): settled is dismissed or resolved. */
  readonly open?: boolean | undefined;
  readonly state?: ConflictState | undefined;
  /** Only the conflicts this change is a party to. */
  readonly changeId?: ChangeId | undefined;
  /** The last `C-n` number an earlier page returned: this page holds the conflicts numbered below it. */
  readonly cursor?: number | undefined;
  /** 1–100; absent is 50. */
  readonly limit?: number | undefined;
}

export interface ConflictListPage {
  readonly items: readonly ConflictRecord[];
  /** The last number returned, when conflicts remain after this page. */
  readonly nextCursor?: number | undefined;
  /** How many of the project's conflicts (of `changeId`'s, when given) are open and settled, whatever the page holds. */
  readonly totals: { readonly open: number; readonly settled: number };
}

/**
 * The Projector's read models of a project, for Mission Control: its changes
 * as a list (newest `#n` first, by state, cursor-paged), a snapshot at the
 * feed's head, from which the console folds the feed forward, and its
 * conflicts (newest `C-n` first) with one conflict's whole record. Head only:
 * there are no snapshots at past cursors.
 */
export class ProjectViews extends Context.Service<
  ProjectViews,
  {
    readonly changes: (read: ChangeListRead) => Effect.Effect<ChangeListPage>;
    readonly snapshot: (project: ProjectId) => Effect.Effect<ViewSnapshot>;
    readonly conflicts: (read: ConflictListRead) => Effect.Effect<ConflictListPage>;
    /** ConflictNotFound for a conflict the project's feed has not seen suspected. */
    readonly conflict: (
      project: ProjectId,
      conflictId: ConflictId,
    ) => Effect.Effect<ConflictRecord, ConflictNotFound>;
    /** The conflict a probe of the project belongs to. ProbeNotFound for a probe the project's feed has not seen drafted or discarded. */
    readonly probeConflict: (
      project: ProjectId,
      probeId: ProbeId,
    ) => Effect.Effect<ConflictRecord, ProbeNotFound>;
  }
>()("keel/ProjectViews") {}
