import type {
  Agent,
  AgentNotKnown,
  AgentStateRefused,
  IdempotencyConflict,
  SponsorRequestRefused,
} from "@keeltown/core/domain/identity";
import { AgentId } from "@keeltown/core/kernel";
import type { NamespaceRecord, SponsorRequest } from "@keeltown/core/ports";
import { Schema } from "effect";
import type {
  Agents_approveSponsorResult,
  Agents_endSponsorshipResult,
  Agents_getAgentResult,
  Agents_listSponsoredResult,
  AskSponsorResult,
} from "../../../generated/http/app.gen.ts";
import type { Caller } from "./caller.ts";
import { admissionRefused, agentProfile } from "./mappers.ts";
import { problem, type ProblemBody } from "./problems.ts";

/**
 * Pure mappers for the link between a person and an agent: the agent's ask,
 * the person's approval, the link's end, the sponsor's list and the card
 * anyone reads. Each error union is mapped exhaustively.
 */

const iso = (ms: number) => new Date(ms).toISOString();

export const decodeLinkAgent = Schema.decodeUnknownOption(AgentId);

/**
 * Where a person approves an agent's ask: the console's page, with the agent
 * and the code in the fragment, so neither is in a request line or a log.
 */
export function approvalUrl(origin: string, agentId: string, code: string): string {
  return `${origin}/sponsor#agent=${encodeURIComponent(agentId)}&code=${encodeURIComponent(code)}`;
}

export function askOk(origin: string, agentId: AgentId, request: SponsorRequest): AskSponsorResult {
  const url = approvalUrl(origin, agentId, request.code);
  const expiresAt = iso(request.expiresAt);
  return {
    status: 201,
    body: {
      ok: true,
      summary: `Show ${url} to the person who will stand behind you. The code is good once, until ${expiresAt}.`,
      result: { code: request.code, url, expiresAt },
      findings: [],
      next: [
        {
          kind: "escalate",
          title: "Show the URL to the person who will stand behind you: they approve it signed in",
        },
        {
          kind: "call",
          title: "Read who you are: your profile names your sponsor once they approve",
          operationId: "whoami",
        },
      ],
      notices: [],
      cost: {},
    },
  };
}

/** The refusals of a link move by the agent as it stands: 409, saying what is in the way. */
function stateRefused(
  caller: Caller,
  error: AgentStateRefused,
): { readonly status: 409; readonly body: ProblemBody } {
  const ending = {
    kind: "call" as const,
    title: "End the link the agent has first",
    operationId: "Agents_endSponsorship",
    args: { agentId: error.agentId },
  };
  switch (error.reason) {
    case "sponsor-held":
      return {
        status: 409,
        body: problem(409, "agent.state_refused", caller.requestId, {
          detail: `${error.agentId} already has a sponsor, and an agent has one.`,
          nextActions: [ending],
        }),
      };
    case "not-sponsored":
      return {
        status: 409,
        body: problem(409, "agent.state_refused", caller.requestId, {
          detail: `${error.agentId} has no sponsor.`,
          nextActions: [
            {
              kind: "call",
              title: "Ask for a sponsor",
              operationId: "askSponsor",
            },
          ],
        }),
      };
    case "paused":
      return {
        status: 409,
        body: problem(409, "agent.state_refused", caller.requestId, {
          detail: `${error.agentId} is paused: its sponsor reinstates it first.`,
          nextActions: [
            {
              kind: "call",
              title: "Reinstate the agent first",
              operationId: "Operator_reinstateAgent",
              args: { agentId: error.agentId },
            },
          ],
        }),
      };
    case "not-a-party":
      return {
        status: 409,
        body: problem(409, "agent.state_refused", caller.requestId, {
          detail: `The link of ${error.agentId} is its sponsor's or its own to end.`,
        }),
      };
    case undefined:
      return {
        status: 409,
        body: problem(409, "agent.state_refused", caller.requestId, {
          detail: `${error.agentId} is ${error.state ?? "not enrolled"}, where ${error.command} is not allowed.`,
        }),
      };
    default: {
      const unmapped: never = error.reason;
      return unmapped;
    }
  }
}

export function askError(
  caller: Caller,
  error: AgentNotKnown | AgentStateRefused,
): AskSponsorResult {
  switch (error._tag) {
    // The gate admitted the caller a moment ago, so this is a race, answered as whoami answers it.
    case "AgentNotKnown":
      return admissionRefused(caller, error);
    case "AgentStateRefused":
      return stateRefused(caller, error);
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/**
 * The one answer to an approval that finds no live request: the code is wrong,
 * used or run out, or there is no such agent. Nothing in it says which, so a
 * code tells its holder nothing about an agent until it is the right one.
 */
export function noSuchRequest(caller: Caller): {
  readonly status: 404;
  readonly body: ProblemBody;
} {
  return {
    status: 404,
    body: problem(404, "resource.not_found", caller.requestId, {
      detail: "No agent is asking for a sponsor with that code.",
      nextActions: [
        { kind: "escalate", title: "Ask the agent to ask again, and approve with its new code" },
      ],
    }),
  };
}

const idempotencyConflict = (caller: Caller, error: IdempotencyConflict, operationId: string) => ({
  status: 409 as const,
  body: problem(409, "request.idempotency_conflict", caller.requestId, {
    detail: `Idempotency-Key ${error.idempotencyKey} was used for a different move on this agent.`,
    nextActions: [
      { kind: "call" as const, title: "Call again with a fresh Idempotency-Key", operationId },
    ],
  }),
});

export function linkOk(agent: Agent): Agents_approveSponsorResult & Agents_endSponsorshipResult {
  return { status: 200, body: agentProfile(agent) };
}

export function approveError(
  caller: Caller,
  error: AgentNotKnown | AgentStateRefused | SponsorRequestRefused | IdempotencyConflict,
): Agents_approveSponsorResult {
  switch (error._tag) {
    case "AgentNotKnown":
    case "SponsorRequestRefused":
      return noSuchRequest(caller);
    case "AgentStateRefused":
      return stateRefused(caller, error);
    case "IdempotencyConflict":
      return idempotencyConflict(caller, error, "Agents_approveSponsor");
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

export function endError(
  caller: Caller,
  error: AgentNotKnown | AgentStateRefused | IdempotencyConflict,
): Agents_endSponsorshipResult {
  switch (error._tag) {
    // The policy saw the agent a moment ago: gone since, it reads as the policy's own not-found.
    case "AgentNotKnown":
      return { status: 404, body: problem(404, "resource.not_found", caller.requestId) };
    case "AgentStateRefused":
      // The policy granted the caller on the directory's row and the agent's own record says
      // otherwise: the link moved in between, and the agent is no more the caller's than a stranger's.
      return error.reason === "not-a-party"
        ? { status: 404, body: problem(404, "resource.not_found", caller.requestId) }
        : stateRefused(caller, error);
    case "IdempotencyConflict":
      return idempotencyConflict(caller, error, "Agents_endSponsorship");
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

export function sponsoredOk(agents: readonly Agent[]): Agents_listSponsoredResult {
  return { status: 200, body: { items: agents.map(agentProfile) } };
}

/**
 * An agent as anyone may see it: who it is, its own namespace when it signed
 * itself up, and the org it works in, by that org's handle. Never its sponsor,
 * its scopes or its standing.
 */
export function cardOk(
  agent: Agent,
  place: { readonly own: NamespaceRecord | undefined; readonly org: string | undefined },
): Agents_getAgentResult {
  const { own, org } = place;
  return {
    status: 200,
    body: {
      id: agent.id,
      name: agent.name,
      ...(agent.handle === undefined ? {} : { handle: agent.handle }),
      ...(own === undefined ? {} : { namespace: { handle: own.handle, kind: own.kind } }),
      ...(agent.kind === undefined ? {} : { kind: agent.kind }),
      ...(org === undefined ? {} : { org }),
    },
  };
}

export function cardNotFound(caller: Caller): Agents_getAgentResult {
  return { status: 404, body: problem(404, "resource.not_found", caller.requestId) };
}

/**
 * The refusal of a person's move that wants a fresh sign-in: a passkey sign-in
 * from the last ten minutes, by the sign-in adapter's own rule.
 */
export function freshSignInRequired(requestId: string): {
  readonly status: 403;
  readonly body: ProblemBody;
} {
  return {
    status: 403,
    body: problem(403, "auth.fresh_sign_in_required", requestId, {
      detail: "This needs a fresh sign-in: a passkey sign-in from the last ten minutes.",
      nextActions: [{ kind: "escalate", title: "Sign in again with your passkey, then retry" }],
    }),
  };
}
