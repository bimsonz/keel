import { Context, type Effect, Schema } from "effect";
import { ChangeState, ParkReason } from "../../domain/coordination/index.ts";
import {
  AgentId,
  ChangeId,
  CommitSha,
  InstantSchema,
  type ProjectId,
} from "../../domain/kernel/index.ts";

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
export type ChangeSummary = typeof ChangeSummary.Type;

/** Trunk's head and height: TrunkInitialized is height 0, and each advance adds 1. */
export const TrunkView = Schema.Struct({ head: CommitSha, height: Schema.Int });
export type TrunkView = typeof TrunkView.Type;

export interface ChangeListRead {
  readonly project: ProjectId;
  readonly state?: ChangeState | undefined;
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

/**
 * The Projector's read models of a project, for Mission Control: its changes
 * as a list (newest `#n` first, by state, cursor-paged) and a snapshot at the
 * feed's head, from which the console folds the feed forward. Head only: there
 * are no snapshots at past cursors.
 */
export class ProjectViews extends Context.Service<
  ProjectViews,
  {
    readonly changes: (read: ChangeListRead) => Effect.Effect<ChangeListPage>;
    readonly snapshot: (project: ProjectId) => Effect.Effect<ViewSnapshot>;
  }
>()("keel/ProjectViews") {}
