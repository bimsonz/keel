import { Effect, Option } from "effect";
import {
  admits,
  type Agent,
  AgentNotAdmitted,
  AgentNotKnown,
  CredentialRejected,
  type IdempotencyConflict,
  type Identity,
  type Principal,
  type Scope,
  ScopeNotGranted,
  type SessionSponsorRefused,
} from "../../domain/identity/index.ts";
import type { Session } from "../../domain/memory/index.ts";
import {
  AgentDirectory,
  type Clock,
  type EnrolInput,
  type Enrolment,
  Enrolments,
  type IssuedToken,
  type OpenSessionInput,
  Sessions,
  TokenIssuer,
} from "../ports/index.ts";

/** identity use-cases. `whoami` and `exchangeToken` are the exemplar for the rest. */

/** Why an agent may not act, or null when it may. */
function refusal(agent: Agent, principal: Principal | null): AgentNotAdmitted["reason"] | null {
  if (agent.state === "suspended") return "suspended";
  if (agent.state === "revoked") return "revoked";
  if (principal !== null && !admits(agent, principal)) return "stale-epoch";
  return null;
}

/**
 * The agent behind a verified token, if it may still act: the token's
 * revocation epoch must match the agent's current one. It reads only the
 * AgentDirectory, so the request gate never calls an AgentSession DO.
 */
export const admit: (
  principal: Principal,
) => Effect.Effect<Agent, AgentNotKnown | AgentNotAdmitted, AgentDirectory> = Effect.fn(
  "identity/admit",
)(function* (principal: Principal) {
  const directory = yield* AgentDirectory;
  const agent = yield* directory.findAgent(principal.agentId);
  if (Option.isNone(agent)) return yield* new AgentNotKnown({ agentId: principal.agentId });
  const reason = refusal(agent.value, principal);
  if (reason !== null) return yield* new AgentNotAdmitted({ agentId: principal.agentId, reason });
  return agent.value;
});

/** Who the caller is: its admitted agent, its current session, and the sponsor its token acts for. */
export const whoami: (
  principal: Principal,
) => Effect.Effect<Identity, AgentNotKnown | AgentNotAdmitted, AgentDirectory | Sessions> =
  Effect.fn("identity/whoami")(function* (principal: Principal) {
    const agent = yield* admit(principal);
    const current = yield* (yield* Sessions).current(agent.id);
    const session = current === null ? null : { id: current.id };
    return principal.onBehalfOf === undefined
      ? { agent, session }
      : { agent, session, onBehalfOf: principal.onBehalfOf };
  });

export interface TokenRequest {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Scopes asked for; every scope the agent holds when absent. */
  readonly scopes?: readonly Scope[];
}

export interface GrantedToken extends IssuedToken {
  readonly scopes: readonly Scope[];
  /** The token's lifetime as issued: its `exp` is its `iat` plus this. */
  readonly expiresInSeconds: number;
}

/** How long a bearer token lives. Short: an agent exchanges its credential again, cheaply. */
export const TOKEN_TTL_SECONDS = 3600;

/** Exchanges a client credential for a short-lived bearer token carrying the agent's current epoch. */
export const exchangeToken: (
  request: TokenRequest,
) => Effect.Effect<
  GrantedToken,
  CredentialRejected | ScopeNotGranted | AgentNotAdmitted,
  AgentDirectory | TokenIssuer | Clock
> = Effect.fn("identity/exchangeToken")(function* (request: TokenRequest) {
  const directory = yield* AgentDirectory;
  const agentId = yield* directory.verifyCredential(request.clientId, request.clientSecret);
  if (Option.isNone(agentId)) return yield* new CredentialRejected();
  const agent = yield* directory.findAgent(agentId.value);
  // A credential whose agent has gone is as good as a wrong secret.
  if (Option.isNone(agent)) return yield* new CredentialRejected();
  const reason = refusal(agent.value, null);
  if (reason !== null) return yield* new AgentNotAdmitted({ agentId: agent.value.id, reason });
  const held = new Set(agent.value.scopes);
  const scopes = request.scopes ?? agent.value.scopes;
  const missing = scopes.filter((scope) => !held.has(scope));
  if (missing.length > 0) return yield* new ScopeNotGranted({ requested: missing });
  const issuer = yield* TokenIssuer;
  const token = yield* issuer.issue(
    {
      agentId: agent.value.id,
      projectId: agent.value.projectId,
      scopes,
      revocationEpoch: agent.value.revocationEpoch,
      ...(agent.value.onBehalfOf === undefined ? {} : { onBehalfOf: agent.value.onBehalfOf }),
    },
    TOKEN_TTL_SECONDS,
  );
  return { ...token, scopes, expiresInSeconds: TOKEN_TTL_SECONDS };
});

/**
 * Enrols an agent in its AgentSession DO, which projects it into the
 * AgentDirectory before answering. The doorways have already checked the
 * operator scope; the bootstrap credential may call only this.
 */
export const enrolAgent: (
  principal: Principal,
  input: EnrolInput,
) => Effect.Effect<Enrolment, IdempotencyConflict, Enrolments> = (principal, input) =>
  Enrolments.use((enrolments) => enrolments.enrol(principal, input));

/** Opens a session for the caller's agent in its AgentSession DO, which makes it the agent's current one. */
export const openAgentSession: (
  principal: Principal,
  input: OpenSessionInput,
) => Effect.Effect<
  Session,
  AgentNotKnown | AgentNotAdmitted | IdempotencyConflict | SessionSponsorRefused,
  Sessions
> = (principal, input) => Sessions.use((sessions) => sessions.open(principal, input));

export * from "./enrol.ts";
export * from "./inbox.ts";
export * from "./reservations.ts";
export * from "./session.ts";
