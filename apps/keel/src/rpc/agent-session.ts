import {
  Agent,
  AgentKind,
  AgentNotice,
  AgentNotAdmitted,
  AgentNotKnown,
  AgentStateRefused,
  IdempotencyConflict,
  InboxPage,
  Scope,
  SponsorRequestRefused,
} from "@keeltown/core/domain/identity";
import { Session } from "@keeltown/core/domain/memory";
import {
  Actor,
  AgentId,
  ChangeId,
  InstantSchema,
  OrgId,
  ProjectId,
  UserId,
} from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";

/** What the AgentSession DO (`agent:<id>`) knows about its agent right now. */
export const SessionSnapshot = Schema.Struct({
  agentId: AgentId,
  /** The agent's current session: the last it opened. */
  session: Schema.NullOr(Session),
  /** Notices no inbox read or tool result has carried yet. */
  inboxDepth: Schema.Int,
  /** Changes whose lease the agent holds. */
  openLeases: Schema.Int,
  /** The share of the agent's derived effects it had declared. Routes review; never judges. Null until Keel derives effects. */
  fidelity: Schema.NullOr(Schema.Number),
});
export type SessionSnapshot = typeof SessionSnapshot.Type;

/**
 * Open a session for the agent this DO is named for. Its sponsor is the
 * agent's, from the enrolment the DO holds. `fingerprint` hashes the request
 * body: the same key with another body is an IdempotencyConflict.
 */
export const OpenSession = Schema.Struct({
  harness: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/** Reserve a change id for a declare's Idempotency-Key. `fingerprint` hashes the request body. */
export const ReserveChange = Schema.Struct({
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

export const InboxRead = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  waitMs: Schema.Int,
});

/** Take the notices no tool result has carried yet: at most `limit`, and never more than 3. */
export const TakeNotices = Schema.Struct({ limit: Schema.Int });

/**
 * Enrol the agent this DO is named for. The isolate derives the agent id from
 * the operator and the Idempotency-Key and mints the client secret, sending only
 * its hash. The DO commits AgentEnrolled and writes the D1 projection before it
 * answers, so the credential exchanges for a token at once. A replay with the
 * same key and body re-issues the credential: it replaces `secretHash`, because
 * the first answer (the only place the secret was shown) was lost. Another body
 * under the same key is an IdempotencyConflict.
 */
export const EnrolCommand = Schema.Struct({
  projectId: ProjectId,
  name: Schema.NonEmptyString,
  kind: AgentKind,
  scopes: Schema.Array(Scope),
  /** The agent's org. */
  org: Schema.optional(OrgId),
  /** The user minting the credential, who becomes the agent's sponsor. */
  sponsor: Schema.optional(UserId),
  clientId: Schema.NonEmptyString,
  /** `sha256:` and the hex digest of the client secret. */
  secretHash: Schema.String,
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/**
 * An operator suspends, reinstates or revokes the agent. `by` is
 * `operator:<agentId>`, the events' `by` and the commit's actor; `reason` is
 * a suspension's. The commit's cause is `standing:<idempotencyKey>`.
 */
export const StandingCommand = Schema.Struct({
  by: Schema.TemplateLiteral(["operator:", Schema.NonEmptyString]),
  reason: Schema.optional(Schema.NonEmptyString),
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

const StandingRefusal = Schema.Union([AgentNotKnown, AgentStateRefused, IdempotencyConflict]);

/** The agent asks for a sponsor: the hash of the code the isolate minted, which is all the object keeps. */
export const AskSponsorCommand = Schema.Struct({ codeHash: Schema.NonEmptyString });

/**
 * A person approves the agent's ask and becomes its sponsor. `codeHash` is the
 * hash of the code presented, absent only from the OAuth provider's consent
 * flow. The commit's cause is `sponsor:<idempotencyKey>`.
 */
export const ApproveSponsorCommand = Schema.Struct({
  by: UserId,
  codeHash: Schema.optional(Schema.NonEmptyString),
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/**
 * The sponsor link ends: `by` is the sponsor or the agent itself, the events'
 * `by` and the commit's actor. The commit's cause is `unsponsor:<idempotencyKey>`.
 */
export const EndSponsorCommand = Schema.Struct({
  by: Actor,
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

export const AgentSessionCodecs = {
  describe: exitCodec(SessionSnapshot, AgentNotKnown),
  openSession: exitCodec(
    Session,
    Schema.Union([AgentNotKnown, AgentNotAdmitted, IdempotencyConflict]),
  ),
  reserveChange: exitCodec(ChangeId, IdempotencyConflict),
  inbox: exitCodec(InboxPage, AgentNotKnown),
  takeNotices: exitCodec(Schema.Array(AgentNotice), Schema.Never),
  enrol: exitCodec(Agent, IdempotencyConflict),
  suspend: exitCodec(Agent, StandingRefusal),
  reinstate: exitCodec(Agent, StandingRefusal),
  revoke: exitCodec(Agent, StandingRefusal),
  askSponsor: exitCodec(InstantSchema, Schema.Union([AgentNotKnown, AgentStateRefused])),
  approveSponsor: exitCodec(
    Agent,
    Schema.Union([AgentNotKnown, AgentStateRefused, SponsorRequestRefused, IdempotencyConflict]),
  ),
  endSponsorship: exitCodec(Agent, StandingRefusal),
};

/** The AgentSession DO: inbox, cursor, leases, fidelity and the agent's live connections. */
export interface AgentSessionRpc extends EventReceiverRpc {
  /** The agent's session, inbox depth and held leases, computed from its rows. AgentNotKnown before it is enrolled. */
  describe(): Promise<ExitJson>;
  /**
   * Opens a session and makes it the agent's current one. Commits
   * SessionOpened on the session's entity; a replayed key and body answers
   * the same session without committing.
   */
  openSession(command: typeof OpenSession.Encoded): Promise<ExitJson>;
  /**
   * The change id for this Idempotency-Key: minted on first use and kept for
   * 24 h, so a retried declare reaches the same change. The same key with a
   * different fingerprint is an IdempotencyConflict.
   */
  reserveChange(request: typeof ReserveChange.Encoded): Promise<ExitJson>;
  /**
   * Notices after `cursor`; with `waitMs` > 0, waits for the next one (an
   * in-DO waiter with a deadline). The read also marks them read, so none of
   * them rides a later tool result.
   */
  inbox(request: typeof InboxRead.Encoded): Promise<ExitJson>;
  /**
   * The piggyback: up to `limit` (at most 3) notices no tool result has
   * carried and no inbox read has returned, oldest first, each with its
   * cursor. Taking them marks them carried in the same commit, so each rides
   * at most one tool result. The inbox still holds them all.
   */
  takeNotices(request: typeof TakeNotices.Encoded): Promise<ExitJson>;
  enrol(command: typeof EnrolCommand.Encoded): Promise<ExitJson>;
  /**
   * Suspends, reinstates or revokes the agent through the domain's Agent
   * machine, writing its directory row (guarded by the event's seq) before
   * answering, so its next request is judged by its new standing.
   */
  suspend(command: typeof StandingCommand.Encoded): Promise<ExitJson>;
  reinstate(command: typeof StandingCommand.Encoded): Promise<ExitJson>;
  revoke(command: typeof StandingCommand.Encoded): Promise<ExitJson>;
  /**
   * The agent's own request for a sponsor, answering when it stops being
   * good. One live request an agent; it commits no event.
   */
  askSponsor(command: typeof AskSponsorCommand.Encoded): Promise<ExitJson>;
  /**
   * A person becomes the agent's sponsor, through the domain's Agent machine.
   * The directory row is written before answering, and the agent is told in
   * its inbox.
   */
  approveSponsor(command: typeof ApproveSponsorCommand.Encoded): Promise<ExitJson>;
  /** Ends the sponsor link, reinstating a paused agent in the same commit. */
  endSponsorship(command: typeof EndSponsorCommand.Encoded): Promise<ExitJson>;
}
