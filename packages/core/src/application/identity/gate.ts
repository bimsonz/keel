import { Effect, Option, Schema } from "effect";
import {
  type Agent,
  type AgentClaims,
  AgentNotAdmitted,
  AgentNotKnown,
  type AgentStanding,
  type Principal,
  givesWork,
  scopesUnder,
  TokenProjectStale,
  TokenRejected,
} from "../../domain/identity/index.ts";
import { AgentId, type NamespaceId, namespaceKind, UserId } from "../../domain/kernel/index.ts";
import {
  AgentDirectory,
  Memberships,
  NamespaceAgents,
  ProjectAgents,
  ProjectNamespaces,
  TokenIssuer,
  Users,
} from "../ports/index.ts";

/**
 * How and when a session was signed in: `by` is the method as the sign-in
 * adapter names it (null for a session made before methods were recorded), `at`
 * the time in epoch milliseconds. A device sign-in approved with a fresh
 * passkey also has `passkeyAt`, that passkey's time. The gate decides nothing
 * on it; an operation that wants a fresh sign-in asks it of the caller.
 */
export interface SignedIn {
  readonly by: string | null;
  readonly at: number;
  readonly passkeyAt?: number;
}

/** An agent's own token as a request presents it: the token, how it was presented, and where. */
export interface PresentedToken {
  readonly token: string;
  /** `DPoP` when the request says the token is bound to a key (RFC 9449 §7.1), else `Bearer`. */
  readonly scheme: "Bearer" | "DPoP";
  /** The request's DPoP proof, when it sent one. */
  readonly proof?: string | undefined;
  readonly method: string;
  /** Where the request was made: Keel's origin and the path, with no query. */
  readonly url: string;
}

/** Why an agent's own token is refused, in the codes RFC 6750 and RFC 9449 give them. */
export interface TokenRefusal {
  readonly refused: "invalid_token" | "invalid_dpop_proof";
  readonly detail: string;
}

/**
 * An agent's own token that could not be checked: something Keel reads to check
 * it did not answer. Nothing is known of the token, so the request is neither
 * admitted nor told its credential is bad.
 */
export interface TokenUnchecked {
  readonly unchecked: true;
}

/**
 * A person's token that an app they allowed holds, as the doorway verified it:
 * the person it acts as, and the app (its client id) that holds it.
 */
export interface AppClaims {
  readonly userId: UserId;
  readonly clientId: string;
}

/**
 * What a request presents, as the doorway reads it: a token of the secret
 * exchange, still to be verified; the claims of an agent's own token, which
 * the doorway has verified (its signature, audience, expiry and key binding);
 * the claims of a person's token an app holds, verified the same way and
 * against the person's standing consent to the app; a user's session; or
 * nothing.
 */
export type Credential =
  | { readonly _tag: "Token"; readonly token: string }
  | { readonly _tag: "Claims"; readonly claims: AgentClaims }
  | { readonly _tag: "App"; readonly claims: AppClaims }
  | { readonly _tag: "Session"; readonly userId: UserId; readonly signedIn: SignedIn }
  | { readonly _tag: "None" };

/**
 * Who the gate admitted: for an agent the claims of the token it verified
 * (which name a project, unless it is a new agent's first), for a user how its
 * session was signed in, and for a user an app acts as, the app. An app's
 * caller has no sign-in of its own, so nothing that asks for a fresh one is
 * done through it.
 */
export interface Admitted {
  readonly principal: Principal;
  readonly token?: AgentClaims;
  readonly signedIn?: SignedIn;
  readonly app?: AppClaims;
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
  principal: AgentClaims,
) => Effect.Effect<Agent, AgentNotKnown | AgentNotAdmitted, AgentDirectory> = Effect.fn(
  "identity/admit",
)(function* (principal: AgentClaims) {
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
  | UserNotKnown
  | TokenProjectStale;

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
 * again. A user is admitted with how and when its session was signed in, and
 * a user an app acts as with the app, and no sign-in of their own.
 *
 * An agent that signed itself up presents its own token, which names one
 * project or none. It stands in that project's namespace, read from the
 * project's place on every request, or in its own when the token names none.
 * It governs its own namespace and nowhere else. In another's it stands where
 * a member invited it and it accepted (`NamespaceAgents`, read on every
 * request): `Invited` by that member's standing now, with its token's scopes
 * cut to what the invitation gives. A pending invitation, an ended one and
 * none at all give it no standing. A token for a project that has no place
 * stands as one for a project the agent has no standing in, so a token never
 * tells whether a project exists. Where it has none, the gate reads whether
 * its invitation there ended, so it is told it left: it stood there, so
 * nothing about the project is told that it did not know.
 *
 * A token that names a run and no project, of a run that has chosen a project
 * to work in, was minted before the choice: it is stale, and the agent asks for
 * a new one, which names that project.
 */
export const principalOf: (
  credential: Credential,
) => Effect.Effect<
  Admitted,
  GateRefusal,
  | TokenIssuer
  | AgentDirectory
  | Users
  | Memberships
  | ProjectNamespaces
  | NamespaceAgents
  | ProjectAgents
> = Effect.fn("identity/principalOf")(function* (credential: Credential) {
  switch (credential._tag) {
    case "None":
      return { principal: { _tag: "Anonymous" } };
    case "Session": {
      const user = yield* Users.use((users) => users.principal(credential.userId));
      if (Option.isNone(user)) return yield* new UserNotKnown({ userId: credential.userId });
      return { principal: user.value, signedIn: credential.signedIn };
    }
    case "App": {
      const { userId } = credential.claims;
      const user = yield* Users.use((users) => users.principal(userId));
      if (Option.isNone(user)) return yield* new UserNotKnown({ userId });
      return { principal: user.value, app: credential.claims };
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
          namespace: org,
          projectId,
          scopes: token.scopes,
          paused: agent.state === "suspended",
          standing,
          sponsored: agent.sponsor !== undefined,
        },
        token,
      };
    }
    case "Claims": {
      const { claims } = credential;
      const agent = yield* admit(claims);
      const own: NamespaceId = agent.id;
      const { projectId, run } = claims;
      if (projectId === undefined && run !== undefined) {
        const chosen = yield* AgentDirectory.use((directory) =>
          directory.runProject(agent.id, run.id),
        );
        if (Option.isSome(chosen))
          return yield* new TokenProjectStale({ agentId: agent.id, run, projectId: chosen.value });
      }
      const place =
        projectId === undefined
          ? Option.none()
          : yield* ProjectNamespaces.use((places) => places.byId(projectId));
      const org = Option.match(place, { onNone: () => own, onSome: (found) => found.namespace });
      const governs = projectId === undefined || (Option.isSome(place) && org === own);
      // An org takes an agent into the whole of it; anyone else's namespace takes it on one project.
      const invited =
        governs || Option.isNone(place) || projectId === undefined
          ? Option.none()
          : namespaceKind(org) === "org"
            ? yield* NamespaceAgents.use((agents) => agents.standing(agent.id, org))
            : yield* ProjectAgents.use((agents) => agents.standing(agent.id, projectId));
      // Only where it stands nowhere is it asked whether it stood there once.
      const left =
        governs || Option.isSome(invited) || Option.isNone(place) || projectId === undefined
          ? false
          : namespaceKind(org) === "org"
            ? yield* NamespaceAgents.use((agents) => agents.ended(agent.id, org))
            : yield* ProjectAgents.use((agents) => agents.ended(agent.id, projectId));
      const standing: AgentStanding = governs
        ? { _tag: "Governs" }
        : Option.isNone(invited)
          ? { _tag: "None", ...(left ? { left: true } : {}) }
          : {
              _tag: "Invited",
              by: yield* Memberships.use((memberships) =>
                memberships.standing(invited.value.by, org),
              ),
              // Outside an org the invitation was to this project, and to nothing else of the namespace.
              ...(namespaceKind(org) === "org" ? {} : { projectOnly: true }),
              ...(givesWork(invited.value.scopes) ? {} : { readOnly: true }),
            };
      return {
        principal: {
          _tag: "Agent",
          agentId: agent.id,
          namespace: org,
          ...(projectId === undefined ? {} : { projectId }),
          // An invitation gives read, or read and work: the token holds no more than it does.
          scopes: Option.match(invited, {
            onNone: () => claims.scopes,
            onSome: (held) => scopesUnder(held.scopes, claims.scopes),
          }),
          paused: agent.state === "suspended",
          standing,
          sponsored: agent.sponsor !== undefined,
        },
        token: claims,
      };
    }
    default: {
      const unmatched: never = credential;
      return unmatched;
    }
  }
});
