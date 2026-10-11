import { Schema } from "effect";
import { AgentId, ProjectId } from "../kernel/index.ts";
import { AgentKind, Scope, Sponsor } from "./agent.ts";

export const AgentEnrolled = Schema.TaggedStruct("AgentEnrolled", {
  agentId: AgentId,
  projectId: ProjectId,
  name: Schema.NonEmptyString,
  kind: AgentKind,
  scopes: Schema.Array(Scope),
  /** The human the agent acts on behalf of, when the operator named one. */
  onBehalfOf: Schema.optional(Sponsor),
});
export const AgentSuspended = Schema.TaggedStruct("AgentSuspended", {
  agentId: AgentId,
  reason: Schema.String,
  by: Schema.String,
});
export const AgentReinstated = Schema.TaggedStruct("AgentReinstated", {
  agentId: AgentId,
  by: Schema.String,
});
export const AgentRevoked = Schema.TaggedStruct("AgentRevoked", {
  agentId: AgentId,
  revocationEpoch: Schema.Int,
  by: Schema.String,
});

export const IdentityEvent = Schema.Union([
  AgentEnrolled,
  AgentSuspended,
  AgentReinstated,
  AgentRevoked,
]);
export type IdentityEvent = typeof IdentityEvent.Type;
