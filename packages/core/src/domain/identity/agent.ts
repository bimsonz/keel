import { Schema } from "effect";
import {
  AgentId,
  InstantSchema,
  NamespaceId,
  ProjectId,
  type RunRef,
  type SessionId,
  UserId,
} from "../kernel/index.ts";
import { AgentKey } from "./agent-key.ts";
import { Handle } from "./handle.ts";

/**
 * `interactive`: an agent a person drives; `hosted`: one Keel's operator runs;
 * `human`: a person; `synthetic`: the load generator's agents, enrolled by the operator.
 */
export const AgentKind = Schema.Literals(["interactive", "hosted", "human", "synthetic"]);
export type AgentKind = typeof AgentKind.Type;

export const Scope = Schema.Literals(["agent:work", "agent:read", "operator", "observer"]);
export type Scope = typeof Scope.Type;

/**
 * The scopes a token may be asked for and an agent enrolled with. `operator` and
 * `observer` confer nothing since tenancy: only the records of agents enrolled
 * before it hold them.
 */
export const GrantableScope = Schema.Literals(["agent:work", "agent:read"]);

export const AgentState = Schema.Literals(["active", "suspended", "revoked"]);
export type AgentState = typeof AgentState.Type;

/** An agent as Keel knows it. Its source of truth is the AgentSession DO; D1 holds a projection. */
export const Agent = Schema.Struct({
  id: AgentId,
  /**
   * The one project an agent enrolled by a person works in. An agent that
   * signed up by key has none: each of its tokens names the project.
   */
  projectId: Schema.optional(ProjectId),
  /** The handle it was given at sign-up, made from its key. An agent enrolled by a person has none. */
  handle: Schema.optional(Handle),
  name: Schema.NonEmptyString,
  /** How an enrolment described the agent. An agent that signed up by key declares its harness per run instead. */
  kind: Schema.optional(AgentKind),
  scopes: Schema.Array(Scope),
  /** The public keys it may prove itself with: at least one for an agent that signed up by key. */
  keys: Schema.optional(Schema.Array(AgentKey)),
  /** The agent's org. Optional only for agents enrolled before tenancy. */
  org: Schema.optional(NamespaceId),
  /**
   * The person who stands behind the agent: the member who enrolled it, or
   * whoever approved its ask. At most one, and the link carries no rights.
   */
  sponsor: Schema.optional(UserId),
  state: AgentState,
  /** Bumped on revocation: a token minted under an earlier epoch is refused. */
  revocationEpoch: Schema.Int,
  createdAt: InstantSchema,
});
export type Agent = typeof Agent.Type;

/**
 * Who a verified token says is calling. A token of an agent that signed up by
 * key may name no project: it stands in the agent's own namespace, where the
 * agent makes its first.
 */
export interface AgentClaims {
  readonly agentId: AgentId;
  /** The one project the token is for, carried in its `prj` claim. */
  readonly projectId?: ProjectId;
  readonly scopes: readonly Scope[];
  readonly revocationEpoch: number;
  /** The agent's org, carried in the token's `org` claim. */
  readonly org?: NamespaceId;
  /** The user who minted the agent's credential: its sponsor, carried in the token's `obo` claim. */
  readonly sponsor?: UserId;
  /** The agent's given handle, when it signed up by key. */
  readonly handle?: Handle;
  /** The run the token is for: one stream of the agent's work. */
  readonly run?: RunRef;
  /**
   * Whether the token is bound to a key its presenter proved it holds on this
   * request. Absent on a token of the secret exchange, which is never bound.
   */
  readonly bound?: boolean;
}

/** A token for one project: what every work use-case takes. */
export interface AgentToken extends AgentClaims {
  readonly projectId: ProjectId;
}

export interface SessionRef {
  readonly id: SessionId;
}

/** What `whoami` answers. */
export interface Identity {
  readonly agent: Agent;
  /** The run the token names, when it names one. */
  readonly run?: RunRef;
  /** The current session of that run, or of the agent's tokens that name none. */
  readonly session: SessionRef | null;
  /** The invitations that wait for the agent to accept them: an org's, and a project's. */
  readonly invitations: { readonly namespaces: number; readonly projects: number };
}

/** A principal may act only while its agent is active and its epoch is current. */
export function admits(agent: Agent, principal: AgentClaims): boolean {
  return agent.state === "active" && principal.revocationEpoch === agent.revocationEpoch;
}
