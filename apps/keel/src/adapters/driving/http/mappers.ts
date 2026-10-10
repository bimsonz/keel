import type { AgentNotAdmitted, AgentNotKnown, CredentialRejected, Identity, ScopeNotGranted } from "@keeltown/core/domain/identity";
import type { GrantedToken } from "@keeltown/core/application/identity";
import type { Auth_exchangeTokenResult, WhoamiResult } from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { problem } from "./problems.ts";

/**
 * Pure mappers between the use-cases' domain results and the generated wire
 * results. Each error union is mapped exhaustively: a new error tag fails to
 * compile here until it is mapped, and a status the spec does not declare is
 * refused by the generated result types.
 */

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function whoamiOk(identity: Identity): WhoamiResult {
  const { agent } = identity;
  return {
    status: 200,
    body: {
      ok: true,
      summary: `You are ${agent.name} (${agent.id}), holding ${agent.scopes.join(", ")}.`,
      result: {
        agent: {
          id: agent.id,
          name: agent.name,
          kind: agent.kind,
          scopes: [...agent.scopes],
          revocationEpoch: agent.revocationEpoch,
          createdAt: iso(agent.createdAt),
        },
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
  switch (error._tag) {
    case "AgentNotKnown":
      return {
        status: 401,
        body: problem(401, "auth.invalid_token", caller.requestId, {
          detail: "The token names an agent Keel does not know.",
          nextActions: [{ kind: "call", title: "Exchange your client credentials for a new token", operationId: "Auth_exchangeToken" }],
        }),
      };
    case "AgentNotAdmitted":
      return {
        status: 401,
        body: problem(401, "auth.revoked", caller.requestId, {
          detail: `The agent may not act: ${error.reason}.`,
          nextActions:
            error.reason === "stale-epoch"
              ? [{ kind: "call", title: "Exchange your client credentials for a token at the current epoch", operationId: "Auth_exchangeToken" }]
              : [{ kind: "escalate", title: "Ask an operator to reinstate the agent" }],
        }),
      };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

export function tokenOk(granted: GrantedToken, now: number): Auth_exchangeTokenResult {
  return {
    status: 200,
    body: {
      access_token: granted.token,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.ceil((granted.expiresAt - now) / 1000)),
      scope: granted.scopes.join(" "),
    },
  };
}

export function tokenError(error: CredentialRejected | ScopeNotGranted | AgentNotAdmitted): Auth_exchangeTokenResult {
  switch (error._tag) {
    case "CredentialRejected":
      return { status: 401, body: { error: "invalid_client", error_description: "Unknown client, or the secret does not match." } };
    case "ScopeNotGranted":
      return { status: 400, body: { error: "invalid_scope", error_description: `Not held: ${error.requested.join(" ")}` } };
    case "AgentNotAdmitted":
      return { status: 401, body: { error: "invalid_client", error_description: `The agent may not act: ${error.reason}.` } };
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}
