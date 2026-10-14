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
import { arrival, problem, type ProblemBody } from "./problems.ts";

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

/** Every predicate's lattice, as the domain publishes it (`LATTICES`). The same for every project. */
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

/** What `whoami` says of the invitations that wait: a clause of its summary, and the read for each kind. */
function waitingInvitations({ namespaces, projects }: Identity["invitations"]) {
  const count = namespaces + projects;
  const kinds = [
    ...(namespaces > 0 ? [namespaces === 1 ? "an org's" : `${namespaces} orgs'`] : []),
    ...(projects > 0 ? [projects === 1 ? "a project's" : `${projects} projects'`] : []),
  ];
  return {
    clause:
      count === 0
        ? ""
        : ` ${count === 1 ? "One invitation waits" : `${count} invitations wait`}: ${kinds.join(" and ")}.`,
    next: [
      ...(namespaces > 0
        ? [
            {
              kind: "read" as const,
              title:
                "An org invited you: read the invitation, then accept it with Agents_acceptInvitation",
              operationId: "Agents_listNamespaces",
            },
          ]
        : []),
      ...(projects > 0
        ? [
            {
              kind: "read" as const,
              title:
                "A project invited you: read the invitation, then accept it with Agents_acceptProjectInvitation",
              operationId: "Agents_listProjects",
            },
          ]
        : []),
    ],
  };
}

/** What `whoami` tells an agent nobody stands behind: that a person must, and the call that asks one. */
function sponsorship(agent: Agent) {
  return agent.sponsor !== undefined
    ? { clause: "", next: [] }
    : {
        clause: " Nobody stands behind you yet: ask a person to sponsor you.",
        next: [
          {
            kind: "call" as const,
            title:
              "Ask a person to sponsor you: askSponsor answers a link, and you show it to them",
            operationId: "askSponsor",
          },
        ],
      };
}

/**
 * What `whoami` tells an agent that signed up by key and stands nowhere but its
 * own namespace, with no invitation waiting: that a member of an org invites it
 * by its handle, and, unless it has work where its token points, that the inbox
 * tells it the moment one does.
 */
function placement({ agent, invitations, joined }: Identity, working: boolean) {
  const standing =
    invitations.namespaces + invitations.projects + joined.namespaces + joined.projects;
  if (agent.projectId !== undefined || standing > 0) return { clause: "", next: [] };
  const handle = agent.handle ?? agent.id;
  return {
    clause: ` You work only in your own namespace, ${handle}: a member of an org invites you into theirs.`,
    next: [
      {
        kind: "escalate" as const,
        title: `To work on an org's projects, ask one of its members to invite you by your handle ${handle}, with read and work`,
      },
      ...(working
        ? []
        : [
            {
              kind: "call" as const,
              title: "Wait in your inbox: Keel tells you the moment an invitation comes",
              operationId: "inbox",
              args: { cursor: "end", wait: 600 },
            },
          ]),
    ],
  };
}

/** The project a token names, as the agent reaches it now, and whether the policy grants it a declare there. */
export interface TokenProject {
  readonly project: { readonly id: string; readonly namespace: string; readonly name: string };
  readonly declares: boolean;
}

/**
 * What `whoami` tells an agent whose token names a project it can work in: the
 * project, to declare a change there and to ask why about a file before changing
 * it. The declare leads every other step.
 */
function work(here: TokenProject | undefined) {
  if (here === undefined || !here.declares) return { clause: "", next: [] };
  const name = `${here.project.namespace}/${here.project.name}`;
  return {
    clause: ` This token is for ${name} (${here.project.id}), where you can work: declare a change there, and ask why about a file before you change it.`,
    next: [
      {
        kind: "call" as const,
        title: `Declare a change on ${name} before you write code: declare answers a workspace to push to and a lease`,
        operationId: "declare",
      },
    ],
  };
}

/**
 * What `whoami` tells an agent that has joined an org or a project: where to
 * read the projects it can work in, each with the id a token names.
 */
function reach({ joined }: Identity) {
  return joined.namespaces + joined.projects === 0
    ? { next: [] }
    : {
        next: [
          {
            kind: "call" as const,
            title: "List the projects you can work in: each project's id is what a token names",
            operationId: "Agents_listReachableProjects",
          },
        ],
      };
}

/** The most steps `whoami` names (the envelope's `next`, `@maxItems(3)`): the first three, in order. */
const MAX_NEXT = 3;

export function whoamiOk(identity: Identity, here?: TokenProject): WhoamiResult {
  const { agent, run, invitations } = identity;
  const inRun = run === undefined ? "" : `, in run ${run.label ?? run.id}`;
  const working = work(here);
  const sponsor = sponsorship(agent);
  const waiting = waitingInvitations(invitations);
  const placed = placement(identity, working.next.length > 0);
  return {
    status: 200,
    body: {
      ok: true,
      summary: `You are ${agent.name} (${agent.id})${inRun}, holding ${agent.scopes.join(", ")}.${working.clause}${sponsor.clause}${waiting.clause}${placed.clause}`,
      result: {
        agent: agentProfile(agent),
        ...(run === undefined ? {} : { run: runView(run) }),
        session: identity.session === null ? null : { id: identity.session.id },
        invitations,
      },
      findings: [],
      next: [
        ...working.next,
        ...sponsor.next,
        ...waiting.next,
        ...placed.next,
        ...reach(identity).next,
      ].slice(0, MAX_NEXT),
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
          nextActions: arrival(),
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
