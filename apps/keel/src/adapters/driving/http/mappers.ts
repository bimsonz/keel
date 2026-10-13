import type {
  Agent,
  AgentNotAdmitted,
  AgentNotKnown,
  CredentialRejected,
  Identity,
  ScopeNotGranted,
} from "@keeltown/core/domain/identity";
import type { GrantedToken, SignedUp } from "@keeltown/core/application/identity";
import { LATTICES } from "@keeltown/core/domain/coordination";
import type { RunRef } from "@keeltown/core/kernel";
import type {
  Auth_exchangeTokenResult,
  Auth_registerClientResult,
  Lattices_listLatticesResult,
  WhoamiResult,
} from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { problem, type ProblemBody } from "./problems.ts";

/**
 * Pure mappers between the use-cases' domain results and the generated wire
 * results. Each error union is mapped exhaustively: a new error tag fails to
 * compile here until it is mapped, and a status the spec does not declare is
 * refused by the generated result types.
 */

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** An agent as the API publishes it (`AgentProfile`). */
export function agentProfile(agent: Agent) {
  return {
    id: agent.id,
    ...(agent.projectId === undefined ? {} : { projectId: agent.projectId }),
    ...(agent.handle === undefined ? {} : { handle: agent.handle }),
    name: agent.name,
    ...(agent.kind === undefined ? {} : { kind: agent.kind }),
    scopes: [...agent.scopes],
    ...(agent.org === undefined ? {} : { namespace: agent.org }),
    ...(agent.sponsor === undefined ? {} : { sponsor: agent.sponsor }),
    revocationEpoch: agent.revocationEpoch,
    state: agent.state,
    createdAt: iso(agent.createdAt),
  };
}

/** Every predicate's lattice, as the domain publishes it (`LATTICES`). The same for every project at L1. */
export function latticesOk(): Lattices_listLatticesResult {
  return {
    status: 200,
    body: {
      items: LATTICES.map((lattice) => ({
        predicate: lattice.predicate,
        ...(lattice.shape === undefined ? {} : { shape: lattice.shape }),
        values: lattice.values.map((value) =>
          value.family === undefined
            ? { id: value.id }
            : { id: value.id, family: { ...value.family } },
        ),
        covers: lattice.covers.map((cover) => ({ lower: cover.lower, upper: cover.upper })),
      })),
    },
  };
}

/** A run as a view names it: its id, and its label when the agent gave one. */
export const runView = (run: RunRef) => ({
  id: run.id,
  ...(run.label === undefined ? {} : { label: run.label }),
});

export function whoamiOk(identity: Identity): WhoamiResult {
  const { agent, run } = identity;
  const inRun = run === undefined ? "" : `, in run ${run.label ?? run.id}`;
  return {
    status: 200,
    body: {
      ok: true,
      summary: `You are ${agent.name} (${agent.id})${inRun}, holding ${agent.scopes.join(", ")}.`,
      result: {
        agent: agentProfile(agent),
        ...(run === undefined ? {} : { run: runView(run) }),
        session: identity.session === null ? null : { id: identity.session.id },
      },
      findings: [],
      next: [],
      notices: [],
      cost: {},
    },
  };
}

export function whoamiError(caller: Caller, error: AgentNotKnown | AgentNotAdmitted): WhoamiResult {
  return admissionRefused(caller, error);
}

/** A token whose agent is unknown or may not act: 401, with the way back. */
export function admissionRefused(
  caller: Caller,
  error: AgentNotKnown | AgentNotAdmitted,
): { readonly status: 401; readonly body: ProblemBody } {
  switch (error._tag) {
    case "AgentNotKnown":
      return {
        status: 401,
        body: problem(401, "auth.invalid_token", caller.requestId, {
          detail: "The token names an agent Keel does not know.",
          nextActions: [
            {
              kind: "call",
              title: "Exchange your client credentials for a new token",
              operationId: "Auth_exchangeToken",
            },
          ],
        }),
      };
    case "AgentNotAdmitted":
      return {
        status: 401,
        body: problem(401, "auth.revoked", caller.requestId, {
          detail: `The agent may not act: ${error.reason}.`,
          nextActions:
            error.reason === "stale-epoch"
              ? [
                  {
                    kind: "call",
                    title: "Exchange your client credentials for a token at the current epoch",
                    operationId: "Auth_exchangeToken",
                  },
                ]
              : [{ kind: "escalate", title: "Ask an operator to reinstate the agent" }],
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/**
 * A sign-up's answer, in dynamic client registration's shape (RFC 7591 §3.2.1):
 * 201 when this request made the account, 200 when the key had signed up before.
 */
export function registeredOk({ agent, created }: SignedUp): Auth_registerClientResult {
  if (agent.handle === undefined || agent.keys === undefined)
    throw new Error(`${agent.id} signed up with no handle or no key`);
  return {
    status: created ? 201 : 200,
    body: {
      client_id: agent.id,
      client_id_issued_at: Math.floor(agent.createdAt / 1000),
      jwks: { keys: agent.keys.map((key) => ({ ...key.jwk })) },
      token_endpoint_auth_method: "private_key_jwt",
      grant_types: ["client_credentials"],
      client_name: agent.name,
      handle: agent.handle,
      kind: "agent",
    },
  };
}

/** A sign-up refused for its key or its proof, in registration's own shape (RFC 7591 §3.2.2). */
export function registrationRefused(
  refused: "invalid_client_metadata" | "invalid_dpop_proof",
  detail: string,
): Auth_registerClientResult {
  return {
    status: refused === "invalid_dpop_proof" ? 401 : 400,
    body: { error: refused, error_description: detail },
  };
}

/** `expires_in` is the lifetime the token was issued with, never re-derived from a later clock read. */
export function tokenOk(granted: GrantedToken): Auth_exchangeTokenResult {
  return {
    status: 200,
    body: {
      access_token: granted.token,
      token_type: "Bearer",
      expires_in: granted.expiresInSeconds,
      scope: granted.scopes.join(" "),
    },
  };
}

export function tokenError(
  error: CredentialRejected | ScopeNotGranted | AgentNotAdmitted,
): Auth_exchangeTokenResult {
  switch (error._tag) {
    case "CredentialRejected":
      return {
        status: 401,
        body: {
          error: "invalid_client",
          error_description: "Unknown client, or the secret does not match.",
        },
      };
    case "ScopeNotGranted":
      return {
        status: 400,
        body: {
          error: "invalid_scope",
          error_description: `Not held: ${error.requested.join(" ")}`,
        },
      };
    case "AgentNotAdmitted":
      return {
        status: 401,
        body: {
          error: "invalid_client",
          error_description: `The agent may not act: ${error.reason}.`,
        },
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}
