import { Schema } from "effect";
import {
  AgentId,
  InstantSchema,
  NamespaceId,
  ProjectId,
  type SessionId,
  UserId,
} from "../kernel/index.ts";

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
  /** The one project the agent is enrolled in. Multi-project enrolment later is additive. */
  projectId: ProjectId,
  name: Schema.NonEmptyString,
  kind: AgentKind,
  scopes: Schema.Array(Scope),
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

/** Who a verified token says is calling. */
export interface AgentToken {
  readonly agentId: AgentId;
  /** The agent's project, carried in the token's `prj` claim. */
  readonly projectId: ProjectId;
  readonly scopes: readonly Scope[];
  readonly revocationEpoch: number;
  /** The agent's org, carried in the token's `org` claim. */
  readonly org?: NamespaceId;
  /** The user who minted the agent's credential: its sponsor, carried in the token's `obo` claim. */
  readonly sponsor?: UserId;
}

export interface SessionRef {
  readonly id: SessionId;
}

/** What `whoami` answers. */
export interface Identity {
  readonly agent: Agent;
  readonly session: SessionRef | null;
}

/** A principal may act only while its agent is active and its epoch is current. */
export function admits(agent: Agent, principal: AgentToken): boolean {
  return agent.state === "active" && principal.revocationEpoch === agent.revocationEpoch;
}
