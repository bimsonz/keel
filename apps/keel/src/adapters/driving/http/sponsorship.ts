import type {
  Agent,
  AgentNotKnown,
  AgentStateRefused,
  IdempotencyConflict,
  SponsorRequestRefused,
  SponsorRequestsLimited,
} from "@keeltown/core/domain/identity";
import { AgentId } from "@keeltown/core/kernel";
import type { SponsorRequest } from "@keeltown/core/ports";
import { Schema } from "effect";
import type {
  Agents_approveSponsorResult,
  Agents_endSponsorshipResult,
  Agents_getAgentResult,
  Agents_listSponsoredResult,
  AskSponsorResult,
  Users_approveSponsorRequestResult,
  Users_declineSponsorRequestResult,
  Users_listBlockedAgentsResult,
  Users_listSponsorRequestsResult,
  Users_unblockAgentResult,
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
          title: "Wait in your inbox: Keel tells you the moment they approve",
          operationId: "inbox",
          args: { cursor: "end", wait: 600 },
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

/**
 * The refusals of a link move by the agent as it stands: 409, saying what is in
 * the way. A held link's end is offered only to a caller who can make it. Of
 * the two who can, the sponsor never reads this refusal (the Agent machine
 * answers their own approval as the link they have), so that is the agent
 * itself; anyone else is told the agent has a sponsor and is given nothing to
 * call.
 */
function stateRefused(
  caller: Caller,
  error: AgentStateRefused,
): { readonly status: 409; readonly body: ProblemBody } {
  switch (error.reason) {
    case "sponsor-held": {
      const itself =
        caller.principal._tag === "Agent" && caller.principal.agentId === error.agentId;
      return {
        status: 409,
        body: problem(409, "agent.state_refused", caller.requestId, {
          detail: `${error.agentId} already has a sponsor, and an agent has one.`,
          nextActions: itself
            ? [
                {
                  kind: "call",
                  title: "End the link you have first",
                  operationId: "Agents_endSponsorship",
                  args: { agentId: error.agentId },
                },
              ]
            : [],
        }),
      };
    }
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
 * code tells its holder nothing about an agent until it is the right one. It
 * does say what to do next, in its detail as well as its next action: the
 * person holds a link that no longer works, and only the agent can give
 * another.
 */
export const NO_SUCH_REQUEST =
  "No agent is asking for a sponsor with that code: it is mistyped, already used or has run out. Ask the agent for a new link, and approve with that one.";

export function noSuchRequest(caller: Caller): {
  readonly status: 404;
  readonly body: ProblemBody;
} {
  return {
    status: 404,
    body: problem(404, "resource.not_found", caller.requestId, {
      detail: NO_SUCH_REQUEST,
      nextActions: [
        { kind: "escalate", title: "Ask the agent for a new link, and approve with it" },
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

type CardBody = Extract<Agents_getAgentResult, { readonly status: 200 }>["body"];

export function sponsoredOk(agents: readonly Agent[]): Agents_listSponsoredResult {
  return { status: 200, body: { items: agents.map(agentProfile) } };
}

/**
 * An agent as anyone may see it: who it is, the handle it was given when it
 * signed itself up, the namespace it works in, by that namespace's handle
 * (an org's, a person's own or an agent's own), and the orgs it has joined.
 * Never its sponsor, its scopes, its standing, or who invited it anywhere.
 */
export function cardOk(
  agent: Agent,
  namespace: string | undefined,
  orgs: NonNullable<CardBody["orgs"]>,
): Agents_getAgentResult {
  return {
    status: 200,
    body: {
      id: agent.id,
      name: agent.name,
      ...(agent.handle === undefined ? {} : { handle: agent.handle }),
      ...(agent.kind === undefined ? {} : { kind: agent.kind }),
      ...(namespace === undefined ? {} : { namespace }),
      ...(orgs.length === 0 ? {} : { orgs }),
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

/** An agent's card as a person's list shows it: the same card anyone reads. */
export type ListedCard = CardBody;

/** The agent's request now waits on the person's own list. */
export function askPersonOk(handle: string, expiresAt: number): AskSponsorResult {
  const until = iso(expiresAt);
  return {
    status: 201,
    body: {
      ok: true,
      summary: `Your request waits on ${handle}'s own list until ${until}, and every agent they sponsor is told of it. They approve or decline it there; you are told which.`,
      result: { person: handle, expiresAt: until },
      findings: [],
      next: [
        {
          kind: "call",
          title: "Wait in your inbox: Keel tells you the moment they approve or decline",
          operationId: "inbox",
          args: { cursor: "end", wait: 600 },
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

/** The one answer to a handle nobody may be asked by: no such person, an agent's or an org's, or a person who blocked the agent. */
function noSuchPerson(caller: Caller, handle: string) {
  return {
    status: 404 as const,
    body: problem(404, "resource.not_found", caller.requestId, {
      detail: `No person you may ask has the handle ${handle}.`,
      nextActions: [
        {
          kind: "escalate" as const,
          title: "Ask a person you know for their handle, or ask for a link to show them",
        },
      ],
    }),
  };
}

export function askPersonError(
  caller: Caller,
  handle: string,
  error:
    | AgentNotKnown
    | AgentStateRefused
    | SponsorRequestRefused
    | SponsorRequestsLimited
    | IdempotencyConflict,
): AskSponsorResult {
  switch (error._tag) {
    case "AgentNotKnown":
      return admissionRefused(caller, error);
    case "AgentStateRefused":
      return stateRefused(caller, error);
    case "SponsorRequestRefused":
      return noSuchPerson(caller, handle);
    case "SponsorRequestsLimited":
      return {
        status: 429,
        body: problem(429, "rate.limited", caller.requestId, {
          detail:
            "You have asked people for sponsorship as often as Keel takes in an hour, or as many requests already wait for that person.",
          retryAfterMs: error.retryAfterMs,
        }),
        headers: { "retry-after": Math.ceil(error.retryAfterMs / 1000) },
      };
    case "IdempotencyConflict":
      return idempotencyConflict(caller, error, "askSponsor");
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/** One request waiting for the person, as their list shows it. */
export interface Waiting {
  readonly agent: CardBody;
  readonly askedAt: number;
  readonly expiresAt: number;
}

export function waitingOk(items: readonly Waiting[]): Users_listSponsorRequestsResult {
  return {
    status: 200,
    body: {
      items: items.map((item) => ({
        agent: item.agent,
        askedAt: iso(item.askedAt),
        expiresAt: iso(item.expiresAt),
      })),
    },
  };
}

export function blockedOk(
  items: readonly { readonly agent: CardBody; readonly blockedAt: number }[],
): Users_listBlockedAgentsResult {
  return {
    status: 200,
    body: { items: items.map((item) => ({ agent: item.agent, blockedAt: iso(item.blockedAt) })) },
  };
}

/** No request from that agent waits for the person (or the agent is not one they blocked). */
export function noRequestFromAgent(caller: Caller) {
  return {
    status: 404 as const,
    body: problem(404, "resource.not_found", caller.requestId, {
      detail: "No request from that agent waits for you.",
      nextActions: [
        {
          kind: "call" as const,
          title: "List the sponsor requests waiting for you",
          operationId: "Users_listSponsorRequests",
        },
      ],
    }),
  };
}

export function approveFromListError(
  caller: Caller,
  error: AgentNotKnown | AgentStateRefused | SponsorRequestRefused | IdempotencyConflict,
): Users_approveSponsorRequestResult {
  switch (error._tag) {
    case "AgentNotKnown":
    case "SponsorRequestRefused":
      return noRequestFromAgent(caller);
    case "AgentStateRefused":
      return stateRefused(caller, error);
    case "IdempotencyConflict":
      return idempotencyConflict(caller, error, "Users_approveSponsorRequest");
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

export function declinedOk(agent: CardBody, blocked: boolean): Users_declineSponsorRequestResult {
  return { status: 200, body: { agent, blocked } };
}

export function declineError(
  caller: Caller,
  error: SponsorRequestRefused | IdempotencyConflict,
): Users_declineSponsorRequestResult {
  switch (error._tag) {
    case "SponsorRequestRefused":
      return noRequestFromAgent(caller);
    case "IdempotencyConflict":
      return idempotencyConflict(caller, error, "Users_declineSponsorRequest");
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

export function unblockedOk(agent: CardBody): Users_unblockAgentResult {
  return { status: 200, body: agent };
}

export function unblockError(
  caller: Caller,
  error: SponsorRequestRefused | IdempotencyConflict,
): Users_unblockAgentResult {
  switch (error._tag) {
    case "SponsorRequestRefused":
      return notBlocked(caller);
    case "IdempotencyConflict":
      return idempotencyConflict(caller, error, "Users_unblockAgent");
    default: {
      const unmapped: never = error;
      return unmapped;
    }
  }
}

/** The agent named is not one the person blocked. */
export function notBlocked(caller: Caller) {
  return {
    status: 404 as const,
    body: problem(404, "resource.not_found", caller.requestId, {
      detail: "You have not blocked that agent.",
    }),
  };
}
