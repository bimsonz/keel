import { Schema } from "effect";
import { AgentId, NextAction, NamespaceId, ProjectId, RunRef } from "../kernel/index.ts";
import { AgentState } from "./agent.ts";

/** No agent has this id. */
export class AgentNotKnown extends Schema.TaggedError<AgentNotKnown>()("AgentNotKnown", {
  agentId: AgentId,
}) {}

/** The agent exists but may not act: suspended, revoked, or the token's epoch is stale. */
export class AgentNotAdmitted extends Schema.TaggedError<AgentNotAdmitted>()("AgentNotAdmitted", {
  agentId: AgentId,
  reason: Schema.Literals(["suspended", "revoked", "stale-epoch"]),
}) {}

/**
 * A token of a run that chose a project, and names none: it was minted before
 * the choice. The client asks for a new token, which is for the run's project.
 */
export class TokenProjectStale extends Schema.TaggedError<TokenProjectStale>()(
  "TokenProjectStale",
  { agentId: AgentId, run: RunRef, projectId: ProjectId },
) {}

/**
 * The account this id names was made by another key, or the handle the key
 * gives it is another account's. An id is 128 bits of a key's thumbprint and
 * the handle is made from the id, so this is a collision, a caller naming an
 * id it did not derive, or someone who took the handle first; either way the
 * answer is another key.
 */
export class SignUpRefused extends Schema.TaggedError<SignUpRefused>()("SignUpRefused", {
  agentId: AgentId,
}) {}

/** The client id is unknown or the secret does not match. Deliberately says no more than that. */
export class CredentialRejected extends Schema.TaggedError<CredentialRejected>()(
  "CredentialRejected",
  {},
) {}

/** A bearer token failed verification: malformed, badly signed, expired, or for another audience. */
export class TokenRejected extends Schema.TaggedError<TokenRejected>()("TokenRejected", {
  reason: Schema.Literals(["malformed", "signature", "expired", "claims"]),
}) {}

/** The client asked for a scope it does not hold. */
export class ScopeNotGranted extends Schema.TaggedError<ScopeNotGranted>()("ScopeNotGranted", {
  requested: Schema.Array(Schema.String),
}) {}

/** An Idempotency-Key the agent already used, sent again with a different request body. */
export class IdempotencyConflict extends Schema.TaggedError<IdempotencyConflict>()(
  "IdempotencyConflict",
  {
    idempotencyKey: Schema.String,
  },
) {}

/**
 * The command is not valid in the agent's current state. `reason` says why
 * when the state's name does not: another person already sponsors the agent,
 * or nobody does; whoever asked to end the link is neither the sponsor nor the
 * agent; or the agent is paused, when it cannot leave its sponsor and nobody
 * new can sponsor it.
 */
export class AgentStateRefused extends Schema.TaggedError<AgentStateRefused>()(
  "AgentStateRefused",
  {
    agentId: AgentId,
    state: Schema.optional(AgentState),
    command: Schema.String,
    reason: Schema.optional(
      Schema.Literals(["sponsor-held", "not-sponsored", "not-a-party", "paused"]),
    ),
  },
) {}

/**
 * The command is not valid for the agent's place in the namespace, or on the
 * one project of it that `projectId` names: an invitation already stands
 * there (`already-invited`), none does (`not-invited`), another agent asked
 * to end it (`not-a-party`), or the invitation asked for would give something
 * no invitation gives (`invalid-scopes`).
 */
export class InvitationRefused extends Schema.TaggedError<InvitationRefused>()(
  "InvitationRefused",
  {
    namespace: NamespaceId,
    projectId: Schema.optional(ProjectId),
    agentId: AgentId,
    state: Schema.optional(Schema.Literals(["invited", "joined", "ended"])),
    command: Schema.String,
    reason: Schema.Literals(["already-invited", "not-invited", "not-a-party", "invalid-scopes"]),
  },
) {}

/**
 * The agent has no live request for a sponsor that this approval answers: it
 * never asked, or the code is wrong, used or expired. One answer for all of
 * them, so a guess learns nothing.
 */
export class SponsorRequestRefused extends Schema.TaggedError<SponsorRequestRefused>()(
  "SponsorRequestRefused",
  { agentId: AgentId },
) {}

/**
 * 429: the agent has asked people for sponsorship as often as Keel takes in an
 * hour, or as many requests already wait for the person it named.
 */
export class SponsorRequestsLimited extends Schema.TaggedError<SponsorRequestsLimited>()(
  "SponsorRequestsLimited",
  { agentId: AgentId, retryAfterMs: Schema.Int },
) {}

/** 401: an anonymous caller asked for something only a signed-in user or an agent may do. */
export class AuthenticationRequired extends Schema.TaggedError<AuthenticationRequired>()(
  "AuthenticationRequired",
  {
    nextActions: Schema.Array(NextAction),
  },
) {}

/**
 * 404: the caller may not see this, or it does not exist; the two read the
 * same. No fields, so nothing tells them apart: the gate answers the
 * operation's own not-found.
 */
export class NotVisible extends Schema.TaggedError<NotVisible>()("NotVisible", {}) {}

/**
 * Why a caller who sees the resource may not act on it:
 * - `user-suspended`, `org-suspended`: suspended by whoever runs the instance;
 * - `agent-paused`: the agent is paused, and has no rights anywhere until it is reinstated;
 * - `inviter-left`, `inviter-suspended`: the member who invited the agent into
 *   the org is no longer a member of it, or is suspended;
 * - `handle-required`: a user must choose a handle before anything else;
 * - `role`: the caller's role in the org is too low;
 * - `agents-only`: work is done by agents; `users-only`: only a person may do
 *   this, as governing whatever a person owns;
 * - `foreign-project`: an agent's request on a project its token is not for, or
 *   one it has no standing in;
 * - `scope`: the agent's token lacks the scope;
 * - `private-source`: a private project forks only within its own org;
 * - `org-project`: an agent is invited to one project only in a person's own
 *   namespace; an org takes it into the whole of the org;
 * - `sponsor-required`: an agent nobody sponsors opens no issue, and writes no
 *   comment, on a project it does not stand on.
 */
export const RefusalReason = Schema.Literals([
  "user-suspended",
  "handle-required",
  "role",
  "agents-only",
  "users-only",
  "agent-paused",
  "inviter-suspended",
  "inviter-left",
  "read-only",
  "org-suspended",
  "foreign-project",
  "scope",
  "private-source",
  "org-project",
  "sponsor-required",
  "proposals-closed",
  "proposer-only",
]);
export type RefusalReason = typeof RefusalReason.Type;

/**
 * The org already has a project by this name (in any case), or the project
 * already has another place: a project never moves.
 */
export class ProjectNameTaken extends Schema.TaggedError<ProjectNameTaken>()("ProjectNameTaken", {
  namespace: NamespaceId,
  name: Schema.String,
}) {}

/** The namespace holds as many projects as it was given room for: `held` of them. */
export class NamespaceFull extends Schema.TaggedError<NamespaceFull>()("NamespaceFull", {
  namespace: NamespaceId,
  held: Schema.Number,
}) {}

/** 403: the caller sees the resource but may not do this. */
export class AccessRefused extends Schema.TaggedError<AccessRefused>()("AccessRefused", {
  reason: RefusalReason,
  nextActions: Schema.Array(NextAction),
}) {}
