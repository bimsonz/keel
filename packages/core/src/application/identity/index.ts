import { Effect, Option } from "effect";
import {
  admits,
  type Agent,
  AgentNotAdmitted,
  AgentNotKnown,
  type AgentKind,
  CredentialRejected,
  type Identity,
  type Principal,
  type Scope,
  ScopeNotGranted,
} from "../../domain/identity/index.ts";
import type { Session } from "../../domain/memory/index.ts";
import { stub } from "../not-implemented.ts";
import {
  AgentDirectory,
  type Clock,
  type Ids,
  type IssuedToken,
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
 * Who the caller is: the agent behind a verified token, if it may still act.
 * The token's revocation epoch must match the agent's current one.
 */
export const whoami: (
  principal: Principal,
) => Effect.Effect<Identity, AgentNotKnown | AgentNotAdmitted, AgentDirectory> = Effect.fn(
  "identity/whoami",
)(function* (principal: Principal) {
  const directory = yield* AgentDirectory;
  const agent = yield* directory.findAgent(principal.agentId);
  if (Option.isNone(agent)) return yield* new AgentNotKnown({ agentId: principal.agentId });
  const reason = refusal(agent.value, principal);
  if (reason !== null) return yield* new AgentNotAdmitted({ agentId: principal.agentId, reason });
  // Sessions are the AgentSession DO's; until they are opened, an agent has none.
  return { agent: agent.value, session: null };
});

export interface TokenRequest {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Scopes asked for; every scope the agent holds when absent. */
  readonly scopes?: readonly Scope[];
}

export interface GrantedToken extends IssuedToken {
  readonly scopes: readonly Scope[];
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
    },
    TOKEN_TTL_SECONDS,
  );
  return { ...token, scopes };
});

export interface EnrolRequest {
  readonly name: string;
  readonly kind: AgentKind;
  readonly scopes: readonly Scope[];
}

export interface Enrolled {
  readonly agent: Agent;
  readonly clientId: string;
  /** Shown once. */
  readonly clientSecret: string;
}

export const enrolAgent: (
  request: EnrolRequest,
) => Effect.Effect<Enrolled, never, AgentDirectory | Ids | Clock> = stub("identity/enrolAgent");

export const openSession: (
  principal: Principal,
  details: { readonly harness?: string; readonly model?: string },
) => Effect.Effect<Session, AgentNotKnown, Ids | Clock> = stub("identity/openSession");

export * from "./inbox.ts";
export * from "./reservations.ts";
