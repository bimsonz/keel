import { Schema } from "effect";
import {
  AgentId,
  BatchId,
  ChangeId,
  CommandActor,
  CommitSha,
  ContentHash,
  EscalationId,
  InstantSchema,
  LeaseId,
  ProjectId,
  RunRef,
  WorkspaceId,
} from "../kernel/index.ts";
import { FootprintEntry, PredicatePolicies, Proposition } from "./proposition.ts";

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

/**
 * Why a change is parked: a person's ruling it waits on, a lease that lapsed
 * while its agent held it, or, for a proposal, the approval of the commit it
 * carries, which comes before anything is verified.
 */
export const ParkReason = Schema.Literals(["awaiting-ruling", "lease-lapsed", "awaiting-approval"]);
export type ParkReason = typeof ParkReason.Type;

/**
 * Why Artifacts would not take a promotion's push: the pack is larger than one
 * receive-pack request may carry, or it would take the repo past its size quota.
 */
export const PushRefusedReason = Schema.Literals(["pack-too-large", "repo-bytes-quota"]);
export type PushRefusedReason = typeof PushRefusedReason.Type;

/** Where a change started: an agent's declare, Keel's own (auditor, operator), or a proposal from a fork. */
export const ChangeOrigin = Schema.Literals(["agent", "auditor", "operator", "proposal"]);
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

/**
 * Where a proposal comes from and where it stands: the fork its commits are
 * copied from, who proposed it (a person, or an agent a person sponsors), and
 * the commit an approval named, while it stands. The commit it carries is the
 * change's own `commitSha`.
 */
export const Proposal = Schema.Struct({
  fork: ProjectId,
  proposer: CommandActor,
  approved: Schema.optional(CommitSha),
});
export type Proposal = typeof Proposal.Type;

export const Change = Schema.Struct({
  id: ChangeId,
  /** The agent holding the change. Absent on a proposal, which no agent holds: Keel holds it, and its proposer moves it. */
  agentId: Schema.optional(AgentId),
  /** The run of that agent which holds the change: the one that declared it, or last adopted it. */
  run: Schema.optional(RunRef),
  origin: ChangeOrigin,
  /** On a proposal alone. */
  proposal: Schema.optional(Proposal),
  state: ChangeState,
  parkReason: Schema.optional(ParkReason),
  intent: Intent,
  /** Absent on a proposal: no agent holds it, so no lease is issued, renewed, lapsed or adopted. */
  lease: Schema.optional(Lease),
  workspaceId: Schema.optional(WorkspaceId),
  createdAt: InstantSchema,
  /** The change's base: its workspace's head when granted. Precheck diffs against it. */
  baseSha: Schema.optional(CommitSha),
  /** The commit last submitted; it is the commit that lands. */
  commitSha: Schema.optional(CommitSha),
  /** Its commit on trunk (`ChangeLanded.commitSha`): set when it lands, never before. */
  landedCommit: Schema.optional(CommitSha),
  /** The lane it was queued on, while Queued or Integrating. */
  laneId: Schema.optional(Schema.String),
  /** The batch it belongs to, while Integrating. Requeue and bounce from Integrating are fenced on it. */
  batchId: Schema.optional(BatchId),
  /** The escalation it waits on, while Parked awaiting a ruling. */
  escalationId: Schema.optional(EscalationId),
  /** Where it was parked from awaiting a ruling or an approval, and so where its resume or approval returns it. */
  parkedFrom: Schema.optional(Schema.Literals(["verifying", "queued"])),
  /** The plan it was last compiled to (PlanCompiled), carried onto ChangeQueued and ChangeRequeued. */
  planHash: Schema.optional(ContentHash),
  /** That plan's predicate policy (PlanCompiled), applied to a proven conflict. Absent, or a predicate left out, is `advise`. */
  predicatePolicy: Schema.optional(PredicatePolicies),
  /** The derivation its current Precheck pass recorded (EffectsDerived): at most one a pass, cleared when the next pass starts. */
  derivationRef: Schema.optional(Schema.String),
  /** The Precheck run of its current pass (PrecheckStarted's Workflow instance): a flow change's ruling is asked of that run. */
  precheckInstance: Schema.optional(Schema.String),
});
export type Change = typeof Change.Type;

/** What preflight suggests an agent does next. */
export const Suggestion = Schema.Literals([
  "proceed",
  "coordinate",
  "refine",
  "sequence",
  "distinguish",
]);
export type Suggestion = typeof Suggestion.Type;

/** A move an agent makes on a conflict with `resolve`: put it to a person, or answer the precedent its ruling set. */
export const Move = Schema.Literals(["escalate", "distinguish"]);
export type Move = typeof Move.Type;
