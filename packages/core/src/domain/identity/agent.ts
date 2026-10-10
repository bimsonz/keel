import { Schema } from "effect";
import { AgentId, InstantSchema, ProjectId, type SessionId } from "../kernel/index.ts";

export const AgentKind = Schema.Literals(["interactive", "hosted", "human"]);
export type AgentKind = typeof AgentKind.Type;

export const Scope = Schema.Literals(["agent:work", "agent:read", "operator", "observer"]);
export type Scope = typeof Scope.Type;

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
  state: AgentState,
  /** Bumped on revocation: a token minted under an earlier epoch is refused. */
  revocationEpoch: Schema.Int,
  createdAt: InstantSchema,
});
export type Agent = typeof Agent.Type;

/** Who a verified token says is calling. */
export interface Principal {
  readonly agentId: AgentId;
  /** The agent's project, carried in the token's `prj` claim. */
  readonly projectId: ProjectId;
  readonly scopes: readonly Scope[];
  readonly revocationEpoch: number;
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
export function admits(agent: Agent, principal: Principal): boolean {
  return agent.state === "active" && principal.revocationEpoch === agent.revocationEpoch;
}
