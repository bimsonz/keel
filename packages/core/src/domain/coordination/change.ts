import { Schema } from "effect";
import {
  AgentId,
  BatchId,
  ChangeId,
  CommitSha,
  EscalationId,
  InstantSchema,
  LeaseId,
  SketchId,
  WorkspaceId,
} from "../kernel/index.ts";
import { FootprintEntry, Proposition } from "./proposition.ts";

export const ChangeState = Schema.Literals([
  "declared",
  "working",
  "submitted",
  "deriving",
  "drifted",
  "verifying",
  "queued",
  "integrating",
  "landed",
  "bounced",
  "parked",
  "withdrawn",
  "superseded",
]);
export type ChangeState = typeof ChangeState.Type;

/** States in which the change waits on its agent. A lease lapses only here. */
export const AGENT_OWNED: ReadonlySet<ChangeState> = new Set([
  "declared",
  "working",
  "drifted",
  "bounced",
]);

export const TERMINAL: ReadonlySet<ChangeState> = new Set(["landed", "withdrawn", "superseded"]);

/** Whether the change waits on its agent. In every other non-terminal state the platform owns it. */
export const isAgentOwned = (state: ChangeState): boolean => AGENT_OWNED.has(state);

export const ParkReason = Schema.Literals(["awaiting-ruling", "lease-lapsed"]);
export type ParkReason = typeof ParkReason.Type;

export const ChangeOrigin = Schema.Literals(["agent", "auditor", "operator"]);
export type ChangeOrigin = typeof ChangeOrigin.Type;

/** What an agent declares before writing code. Each revision is immutable. */
export const Intent = Schema.Struct({
  revision: Schema.Int,
  goal: Schema.NonEmptyString,
  footprint: Schema.Array(FootprintEntry),
  premises: Schema.Array(Proposition),
  /** Effects the agent expects to cause. Advisory only: verdicts use derived effects. */
  declaredEffects: Schema.optional(Schema.Array(Proposition)),
});
export type Intent = typeof Intent.Type;

export const LeaseState = Schema.Literals(["active", "lapsed", "released", "superseded"]);
export type LeaseState = typeof LeaseState.Type;

/** A permit to act on a change, with a server-minted fencing token. Never exclusive over files. */
export const Lease = Schema.Struct({
  id: LeaseId,
  agentId: AgentId,
  renewedAt: InstantSchema,
  state: LeaseState,
});
export type Lease = typeof Lease.Type;

/** A lease lapses this long after its last renewal. */
export const LEASE_TTL_MS = 15 * 60 * 1000;

export const Change = Schema.Struct({
  id: ChangeId,
  agentId: AgentId,
  origin: ChangeOrigin,
  state: ChangeState,
  parkReason: Schema.optional(ParkReason),
  intent: Intent,
  lease: Lease,
  workspaceId: Schema.optional(WorkspaceId),
  fromSketch: Schema.optional(SketchId),
  createdAt: InstantSchema,
  /** The commit last submitted; it is the commit that lands. */
  commitSha: Schema.optional(CommitSha),
  /** The lane it was queued on, while Queued or Integrating. */
  laneId: Schema.optional(Schema.String),
  /** The batch it belongs to, while Integrating. Requeue and bounce from Integrating are fenced on it. */
  batchId: Schema.optional(BatchId),
  /** The escalation it waits on, while Parked awaiting a ruling. */
  escalationId: Schema.optional(EscalationId),
});
export type Change = typeof Change.Type;

/** A coordination action Keel suggests or an agent takes. */
export const Move = Schema.Literals([
  "proceed",
  "coordinate",
  "refine",
  "sequence",
  "yield",
  "merge",
  "distinguish",
  "escalate",
]);
export type Move = typeof Move.Type;
