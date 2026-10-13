import { Effect, Option, Schema } from "effect";
import {
  type Agent,
  AgentNotAdmitted,
  AgentNotKnown,
  type AgentStanding,
  type AgentToken,
  type Principal,
  TokenRejected,
} from "../../domain/identity/index.ts";
import { AgentId, UserId } from "../../domain/kernel/index.ts";
import { AgentDirectory, Memberships, TokenIssuer, Users } from "../ports/index.ts";

/**
 * How and when a session was signed in: `by` is the method as the sign-in
 * adapter names it (null for a session made before methods were recorded), `at`
 * the time in epoch milliseconds. The gate decides nothing on it; an operation
 * that wants a fresh sign-in asks it of the caller.
 */
export interface SignedIn {
  readonly by: string | null;
  readonly at: number;
}

/** What a request presents, as the doorway reads it: a Keel token, a user's session, or nothing. */
export type Credential =
  | { readonly _tag: "Token"; readonly token: string }
  | { readonly _tag: "Session"; readonly userId: UserId; readonly signedIn: SignedIn }
  | { readonly _tag: "None" };

/** Who the gate admitted: for an agent the token it verified, for a user how its session was signed in. */
export interface Admitted {
  readonly principal: Principal;
  readonly token?: AgentToken;
  readonly signedIn?: SignedIn;
}

/**
 * An agent enrolled before tenancy that the cutover has not placed: it has no
 * org, so there is nowhere for it to stand. Refused by name, never given a
 * default.
 */
export class AgentUnplaced extends Schema.TaggedError<AgentUnplaced>()("AgentUnplaced", {
  agentId: AgentId,
}) {}

/** A session whose user no longer exists. */
export class UserNotKnown extends Schema.TaggedError<UserNotKnown>()("UserNotKnown", {
  userId: UserId,
}) {}

/** Why no token is minted for an agent, or null when one is: only an active agent is given one. */
export function whyNotAdmitted(agent: Agent): AgentNotAdmitted["reason"] | null {
  if (agent.state === "suspended") return "suspended";
  if (agent.state === "revoked") return "revoked";
  return null;
}

/**
 * The agent behind a verified token, if it is still an agent of Keel's: a
 * revoked one is refused, and the token's revocation epoch must match the
 * agent's current one. A suspended agent is let through as it stands, so the
 * policy answers each of its requests with why (`agent-paused`) and what to do
 * next. It reads only the AgentDirectory, so the request gate never calls an
 * AgentSession DO.
 */
export const admit: (
  principal: AgentToken,
) => Effect.Effect<Agent, AgentNotKnown | AgentNotAdmitted, AgentDirectory> = Effect.fn(
  "identity/admit",
)(function* (principal: AgentToken) {
  const directory = yield* AgentDirectory;
  const agent = yield* directory.findAgent(principal.agentId);
  if (Option.isNone(agent)) return yield* new AgentNotKnown({ agentId: principal.agentId });
  if (agent.value.state === "revoked")
    return yield* new AgentNotAdmitted({ agentId: principal.agentId, reason: "revoked" });
  if (principal.revocationEpoch !== agent.value.revocationEpoch)
    return yield* new AgentNotAdmitted({ agentId: principal.agentId, reason: "stale-epoch" });
  return agent.value;
});

export type GateRefusal =
  | TokenRejected
  | AgentNotKnown
  | AgentNotAdmitted
  | AgentUnplaced
  | UserNotKnown;

/**
 * Who is asking: a Keel token is an agent, a
 * session is a user, and nothing is anonymous. An agent
 * stands on its D1 row: its epoch, its org, and its sponsor's standing in that
 * org, read on every request. Until an invitation is a record of its own, the
 * person behind an agent is the member who invited it: the agent stands
 * `Invited` by its sponsor. With nobody behind it, nobody answers for it in its
 * org, and it stands there as the public: it still reads who it is and may ask
 * for a sponsor. A token whose `org` is not its agent's current one (minted
 * before the agent was placed) is stale, and the agent exchanges its credential
 * again. A user is admitted with how and when its session was signed in.
 */
export const principalOf: (
  credential: Credential,
) => Effect.Effect<Admitted, GateRefusal, TokenIssuer | AgentDirectory | Users | Memberships> =
  Effect.fn("identity/principalOf")(function* (credential: Credential) {
    switch (credential._tag) {
      case "None":
        return { principal: { _tag: "Anonymous" } };
      case "Session": {
        const user = yield* Users.use((users) => users.principal(credential.userId));
        if (Option.isNone(user)) return yield* new UserNotKnown({ userId: credential.userId });
        return { principal: user.value, signedIn: credential.signedIn };
      }
      case "Token": {
        const token = yield* TokenIssuer.use((issuer) => issuer.verify(credential.token));
        const agent = yield* admit(token);
        if (agent.org === undefined || agent.projectId === undefined)
          return yield* new AgentUnplaced({ agentId: agent.id });
        if (token.org !== agent.org) return yield* new TokenRejected({ reason: "claims" });
        const { org, sponsor: sponsorId, projectId } = agent;
        const standing: AgentStanding =
          sponsorId === undefined
            ? { _tag: "None" }
            : {
                _tag: "Invited",
                by: yield* Memberships.use((memberships) => memberships.standing(sponsorId, org)),
              };
        return {
          principal: {
            _tag: "Agent",
            agentId: agent.id,
            org,
            projectId,
            scopes: token.scopes,
            paused: agent.state === "suspended",
            standing,
          },
          token,
        };
      }
      default: {
        const unmatched: never = credential;
        return unmatched;
      }
    }
  });
