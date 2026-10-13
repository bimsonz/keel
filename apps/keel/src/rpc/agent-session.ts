import {
  Agent,
  AgentKind,
  AgentNotice,
  AgentNotAdmitted,
  AgentNotKnown,
  AgentStateRefused,
  Handle,
  IdempotencyConflict,
  InboxPage,
  PresentedKey,
  Scope,
  SignUpRefused,
  SponsorRequestRefused,
} from "@keeltown/core/domain/identity";
import { Session } from "@keeltown/core/domain/memory";
import {
  CommandActor,
  AgentId,
  ChangeId,
  InstantSchema,
  NamespaceId,
  ProjectId,
  RunId,
  RunRef,
  UserId,
} from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";

/**
 * The header that names the run on a socket upgrade the isolate forwards to
 * the object. The isolate sets it from the token the gate admitted and takes
 * out whatever the client sent under it; the object reads the run from nowhere else.
 */
export const RUN_HEADER = "x-keel-run";

/** Which of the agent's runs asks: none for an agent that names no run (a client secret, a plain token). */
export const DescribeSession = Schema.Struct({ run: Schema.optional(RunId) });

/** What the AgentSession DO (`agent:<id>`) knows about its agent right now, as the run that asks sees it. */
export const SessionSnapshot = Schema.Struct({
  agentId: AgentId,
  /** The run's current session: the last it opened. */
  session: Schema.NullOr(Session),
  /** Notices for the run that no inbox read or tool result of its own has carried yet. */
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
  /** The run that opens the session, from its token: the session is that run's current one. */
  run: Schema.optional(RunRef),
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

/**
 * Read the inbox as one run of the agent: what is for it or for every run, never what it caused.
 * The cursor `end` is the head's, found once. With `peek` the read counts nothing as read.
 */
export const InboxRead = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  waitMs: Schema.Int,
  run: Schema.optional(RunId),
  peek: Schema.optional(Schema.Boolean),
});

/** Take the notices no tool result of this run has carried yet: at most `limit`, and never more than 3. */
export const TakeNotices = Schema.Struct({ limit: Schema.Int, run: Schema.optional(RunId) });

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
  /** The namespace the agent works in. A command that names none does not decode, so no agent is enrolled nowhere. */
  namespace: NamespaceId,
  /** The user minting the credential, who becomes the agent's sponsor. */
  sponsor: Schema.optional(UserId),
  clientId: Schema.NonEmptyString,
  /** `sha256:` and the hex digest of the client secret. */
  secretHash: Schema.String,
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

/**
 * An agent signs itself up with a key. The isolate makes the agent
 * id and the handle from the key, so the same key reaches this object every
 * time; the DO commits AgentSignedUp and writes the D1 projection and the key
 * before it answers. The same key again answers the same agent. Another key
 * under this id is SignUpRefused.
 */
export const SignUpCommand = Schema.Struct({
  handle: Handle,
  key: PresentedKey,
  name: Schema.optional(Schema.NonEmptyString),
});

/**
 * A person suspends, reinstates or revokes the agent. `by` is who, as the
 * envelope names an actor (`user:<id>`): the events' `by` and the commit's
 * actor; `reason` is a suspension's. The commit's cause is
 * `standing:<idempotencyKey>`.
 */
export const StandingCommand = Schema.Struct({
  by: CommandActor,
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
 * `by` and the commit's actor, and `run` the run an agent ends it in, from its
 * token. The commit's cause is `unsponsor:<idempotencyKey>`.
 */
export const EndSponsorCommand = Schema.Struct({
  by: CommandActor,
  run: Schema.optional(RunRef),
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
  signUp: exitCodec(Agent, SignUpRefused),
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
  /** The asking run's session and inbox depth and the agent's held leases, computed from its rows. AgentNotKnown before it is enrolled. */
  describe(request?: typeof DescribeSession.Encoded): Promise<ExitJson>;
  /**
   * Opens a session and makes it the current one of the run that opens it. Commits
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
   * Notices after `cursor` for the run that reads; with `waitMs` > 0, waits
   * for the next one (an in-DO waiter with a deadline). The read also marks
   * them read for that run, so none of them rides a later tool result of its.
   */
  inbox(request: typeof InboxRead.Encoded): Promise<ExitJson>;
  /**
   * The piggyback: up to `limit` (at most 3) notices for the run that no
   * tool result of its own has carried and no inbox read of its own has
   * returned, oldest first, each with its cursor. Taking them marks them
   * carried for that run in the same commit, so each rides at most one of its
   * tool results. The inbox still holds them all.
   */
  takeNotices(request: typeof TakeNotices.Encoded): Promise<ExitJson>;
  enrol(command: typeof EnrolCommand.Encoded): Promise<ExitJson>;
  signUp(command: typeof SignUpCommand.Encoded): Promise<ExitJson>;
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
