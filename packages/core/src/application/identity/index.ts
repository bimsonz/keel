import { Effect, Option } from "effect";
import {
  type Actor,
  type Agent,
  AgentNotAdmitted,
  type AgentNotKnown,
  type AgentStateRefused,
  CredentialRejected,
  type IdempotencyConflict,
  type Identity,
  type AgentClaims,
  type AgentToken,
  type Scope,
  ScopeNotGranted,
} from "../../domain/identity/index.ts";
import { ProjectNotFound } from "../../domain/integration/index.ts";
import type { UserId } from "../../domain/kernel/index.ts";
import type { Session } from "../../domain/memory/index.ts";
import { admit, whyNotAdmitted } from "./gate.ts";
import {
  AgentDirectory,
  type Clock,
  type EnrolInput,
  type Enrolment,
  Enrolments,
  type IssuedToken,
  type OpenSessionInput,
  ProjectNamespaces,
  Sessions,
  type StandingInput,
  Standings,
  TokenIssuer,
} from "../ports/index.ts";

/** identity use-cases. `whoami` and `exchangeToken` are the exemplar for the rest. */

/** Who the caller is: its admitted agent, with its org and sponsor, the run its token names, and that run's current session. */
export const whoami: (
  principal: AgentClaims,
) => Effect.Effect<Identity, AgentNotKnown | AgentNotAdmitted, AgentDirectory | Sessions> =
  Effect.fn("identity/whoami")(function* (principal: AgentClaims) {
    const agent = yield* admit(principal);
    const current = yield* (yield* Sessions).current(agent.id, principal.run?.id);
    return {
      agent,
      ...(principal.run === undefined ? {} : { run: principal.run }),
      session: current === null ? null : { id: current.id },
    };
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

/**
 * Exchanges a client credential for a short-lived bearer token carrying the
 * agent's current epoch, its org and its sponsor.
 */
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
  // A credential whose agent has gone is as good as a wrong secret. So is one for an agent with
  // no project: only an agent a person enrolled in a project holds a client secret.
  if (Option.isNone(agent) || agent.value.projectId === undefined)
    return yield* new CredentialRejected();
  const reason = whyNotAdmitted(agent.value);
  if (reason !== null) return yield* new AgentNotAdmitted({ agentId: agent.value.id, reason });
  const held = new Set(agent.value.scopes);
  const scopes = request.scopes ?? agent.value.scopes;
  const missing = scopes.filter((scope) => !held.has(scope));
  if (missing.length > 0) return yield* new ScopeNotGranted({ requested: missing });
  const issuer = yield* TokenIssuer;
  const { org, sponsor, projectId } = agent.value;
  const token = yield* issuer.issue(
    {
      agentId: agent.value.id,
      projectId,
      scopes,
      revocationEpoch: agent.value.revocationEpoch,
      ...(org === undefined ? {} : { org }),
      ...(sponsor === undefined ? {} : { sponsor }),
    },
    TOKEN_TTL_SECONDS,
  );
  return { ...token, scopes, expiresInSeconds: TOKEN_TTL_SECONDS };
});

/** An enrolment as the doorway hands it over: its namespace is its project's, and its sponsor the caller. */
export type EnrolAgentInput = Omit<EnrolInput, "namespace" | "sponsor">;

/**
 * Enrols an agent in a project, sponsored by the user minting its credential,
 * whom the doorway authorised on the project. The agent's namespace is the project's;
 * a project with no place is ProjectNotFound. Its AgentSession DO projects it
 * into the AgentDirectory before answering.
 */
export const enrolAgent: (
  sponsor: UserId,
  input: EnrolAgentInput,
) => Effect.Effect<
  Enrolment,
  IdempotencyConflict | ProjectNotFound,
  Enrolments | ProjectNamespaces
> = Effect.fn("identity/enrolAgent")(function* (sponsor: UserId, input: EnrolAgentInput) {
  const place = yield* (yield* ProjectNamespaces).byId(input.projectId);
  if (Option.isNone(place)) return yield* new ProjectNotFound({ projectId: input.projectId });
  return yield* (yield* Enrolments).enrol(
    { _tag: "User", userId: sponsor },
    { ...input, namespace: place.value.namespace, sponsor },
  );
});

/**
 * Suspends, reinstates or revokes an agent in its AgentSession DO, which
 * writes the directory row before answering, as the actor the doorway
 * authorised.
 */
export const suspendAgent: (
  actor: Actor,
  input: StandingInput,
) => Effect.Effect<Agent, AgentNotKnown | AgentStateRefused | IdempotencyConflict, Standings> = (
  actor,
  input,
) => Standings.use((standings) => standings.suspend(actor, input));

export const reinstateAgent: (
  actor: Actor,
  input: StandingInput,
) => Effect.Effect<Agent, AgentNotKnown | AgentStateRefused | IdempotencyConflict, Standings> = (
  actor,
  input,
) => Standings.use((standings) => standings.reinstate(actor, input));

export const revokeAgent: (
  actor: Actor,
  input: StandingInput,
) => Effect.Effect<Agent, AgentNotKnown | AgentStateRefused | IdempotencyConflict, Standings> = (
  actor,
  input,
) => Standings.use((standings) => standings.revoke(actor, input));

/** Opens a session for the caller's agent in its AgentSession DO, which makes it the agent's current one. */
export const openAgentSession: (
  principal: AgentToken,
  input: OpenSessionInput,
) => Effect.Effect<Session, AgentNotKnown | AgentNotAdmitted | IdempotencyConflict, Sessions> = (
  principal,
  input,
) => Sessions.use((sessions) => sessions.open(principal, input));

export * from "./enrol.ts";
export * from "./gate.ts";
export * from "./inbox.ts";
export * from "./org-usage.ts";
export * from "./reservations.ts";
export * from "./session.ts";
export * from "./sign-up.ts";
export * from "./sponsorship.ts";
export * from "./standing.ts";
