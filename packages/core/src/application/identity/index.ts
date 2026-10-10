import { Effect } from "effect";
import type {
  AgentKind,
  AgentNotAdmitted,
  AgentNotKnown,
  CredentialRejected,
  Identity,
  Principal,
  Scope,
  ScopeNotGranted,
} from "../../domain/identity/index.ts";
import type { Agent } from "../../domain/identity/index.ts";
import type { Session } from "../../domain/memory/index.ts";
import { NotImplemented } from "../not-implemented.ts";
import type { AgentDirectory, Clock, Ids, IssuedToken, TokenIssuer } from "../ports/index.ts";

/** identity use-cases. `whoami` and `exchangeToken` are the exemplar for the rest. */

export interface TokenRequest {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Scopes asked for; every scope the agent holds when absent. */
  readonly scopes?: readonly Scope[];
}

export interface GrantedToken extends IssuedToken {
  readonly scopes: readonly Scope[];
}

export const whoami: (principal: Principal) => Effect.Effect<Identity, AgentNotKnown | AgentNotAdmitted, AgentDirectory> =
  Effect.fn("identity/whoami")(function* (_principal: Principal) {
    return yield* Effect.die(new NotImplemented("identity/whoami"));
  });

export const exchangeToken: (
  request: TokenRequest,
) => Effect.Effect<GrantedToken, CredentialRejected | ScopeNotGranted | AgentNotAdmitted, AgentDirectory | TokenIssuer | Clock> =
  Effect.fn("identity/exchangeToken")(function* (_request: TokenRequest) {
    return yield* Effect.die(new NotImplemented("identity/exchangeToken"));
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

export const enrolAgent: (request: EnrolRequest) => Effect.Effect<Enrolled, never, AgentDirectory | Ids | Clock> = Effect.fn(
  "identity/enrolAgent",
)(function* (_request: EnrolRequest) {
  return yield* Effect.die(new NotImplemented("identity/enrolAgent"));
});

export const openSession: (
  principal: Principal,
  details: { readonly harness?: string; readonly model?: string },
) => Effect.Effect<Session, AgentNotKnown, Ids | Clock> = Effect.fn("identity/openSession")(function* (
  _principal: Principal,
  _details: { readonly harness?: string; readonly model?: string },
) {
  return yield* Effect.die(new NotImplemented("identity/openSession"));
});
