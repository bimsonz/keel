import { Schema } from "effect";
import { AgentId, NamespaceId, OrgId, ProjectId, UserId } from "../kernel/index.ts";
import { AgentKind, Scope } from "./agent.ts";
import { PresentedKey } from "./agent-key.ts";
import { Handle, Role } from "./tenancy.ts";

export const AgentEnrolled = Schema.TaggedStruct("AgentEnrolled", {
  agentId: AgentId,
  projectId: ProjectId,
  name: Schema.NonEmptyString,
  kind: AgentKind,
  scopes: Schema.Array(Scope),
  /** The agent's org. Optional only so agents enrolled before tenancy still decode. */
  org: Schema.optional(NamespaceId),
  /** The user who minted the agent's credential: its sponsor, accountable for it. */
  sponsor: Schema.optional(UserId),
});
/**
 * An agent signed itself up with a key: no person, no project. Its
 * id and handle are made from that key.
 */
export const AgentSignedUp = Schema.TaggedStruct("AgentSignedUp", {
  agentId: AgentId,
  handle: Handle,
  /** What the agent calls itself: a label, never an address. */
  name: Schema.optional(Schema.NonEmptyString),
  key: PresentedKey,
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
/**
 * A person stands behind the agent: a link that carries no rights and needs
 * no org. The agent asked for it and the person approved it.
 */
export const AgentSponsored = Schema.TaggedStruct("AgentSponsored", {
  agentId: AgentId,
  sponsor: UserId,
});
/** The link ended. `by` is whoever ended it: the sponsor, or the agent itself. */
export const AgentUnsponsored = Schema.TaggedStruct("AgentUnsponsored", {
  agentId: AgentId,
  sponsor: UserId,
  by: Schema.String,
});

/** The events of one agent, which the AgentSession DO commits. */
export const AgentEvent = Schema.Union([
  AgentEnrolled,
  AgentSignedUp,
  AgentSuspended,
  AgentReinstated,
  AgentRevoked,
  AgentSponsored,
  AgentUnsponsored,
]);
export type AgentEvent = typeof AgentEvent.Type;

/**
 * Tenancy events. Better Auth's tables in D1 are identity's source
 * of truth; its after-hooks commit these for the feed and the audit, one per
 * row-state change, keyed `user:<userId>` or `org:<orgId>`. Authorization never
 * reads them. No event carries an email address.
 */
export const UserSignedUp = Schema.TaggedStruct("UserSignedUp", {
  userId: UserId,
  /** Absent until the user chooses one. */
  handle: Schema.optional(Handle),
});
/**
 * An org was made. A person's own namespace is no org and never one of these:
 * the events of an older Keel carried `personal` for the org a sign-up made,
 * which is still read and no longer written.
 */
export const OrgCreated = Schema.TaggedStruct("OrgCreated", {
  orgId: OrgId,
  name: Handle,
  by: UserId,
});
/**
 * A user joined an org (`to` alone), left it (`from` alone), or changed role.
 * `by` is absent when the user acted alone, e.g. accepting an invitation.
 */
export const MembershipChanged = Schema.TaggedStruct("MembershipChanged", {
  orgId: OrgId,
  userId: UserId,
  from: Schema.optional(Role),
  to: Schema.optional(Role),
  by: Schema.optional(UserId),
}).check(
  Schema.makeFilter(
    (e) =>
      e.from !== e.to ||
      "a membership change names the role left or the role taken, and they differ",
  ),
);
export const UserSuspended = Schema.TaggedStruct("UserSuspended", {
  userId: UserId,
  reason: Schema.String,
  by: UserId,
});
export const UserReinstated = Schema.TaggedStruct("UserReinstated", {
  userId: UserId,
  by: UserId,
});
export const OrgSuspended = Schema.TaggedStruct("OrgSuspended", {
  orgId: OrgId,
  reason: Schema.String,
  by: UserId,
});
export const OrgReinstated = Schema.TaggedStruct("OrgReinstated", {
  orgId: OrgId,
  by: UserId,
});
/** An org and everything it owned are gone: its projects, repos, R2 prefix, objects and rows. */
export const OrgDeleted = Schema.TaggedStruct("OrgDeleted", {
  orgId: OrgId,
});

export const IdentityEvent = Schema.Union([
  AgentEnrolled,
  AgentSignedUp,
  AgentSuspended,
  AgentReinstated,
  AgentRevoked,
  AgentSponsored,
  AgentUnsponsored,
  UserSignedUp,
  OrgCreated,
  MembershipChanged,
  UserSuspended,
  UserReinstated,
  OrgSuspended,
  OrgReinstated,
  OrgDeleted,
]);
export type IdentityEvent = typeof IdentityEvent.Type;
