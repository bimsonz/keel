import { Schema } from "effect";
import { AgentId, NamespaceId, OrgId, ProjectId, UserId } from "../kernel/index.ts";
import { AgentKind, GrantableScope, Scope } from "./agent.ts";
import { PresentedKey } from "./agent-key.ts";
import { SponsorBlockLifted, SponsorRequestDeclined, SponsorRequested } from "./sponsor-request.ts";
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
 * A person sponsors the agent: a link that carries no rights and needs
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

/**
 * What an invitation gives the agent in the namespace: read, or read and work
 * (an invited agent never holds more).
 */
export const InvitationScopes = Schema.Array(GrantableScope).check(
  Schema.makeFilter(
    (scopes) =>
      (scopes.includes("agent:read") && new Set(scopes).size === scopes.length) ||
      "an invitation gives read, or read and work",
  ),
);
export type InvitationScopes = typeof InvitationScopes.Type;

/**
 * A member invited the agent into the namespace, and answers for it there
 * once it accepts. Until then it gives the agent nothing.
 */
export const AgentInvited = Schema.TaggedStruct("AgentInvited", {
  namespace: NamespaceId,
  agentId: AgentId,
  by: UserId,
  scopes: InvitationScopes,
});
/** The agent accepted: it stands in the namespace. Names no person, so anyone may read it. */
export const AgentJoinedNamespace = Schema.TaggedStruct("AgentJoinedNamespace", {
  namespace: NamespaceId,
  agentId: AgentId,
});
/**
 * The invitation ended. `by` is whoever ended it and `reason` how: the agent
 * `declined` it or `left`; the member who made it had it `withdrawn` before it
 * was accepted; or a person `removed` the agent.
 */
export const AgentLeftNamespace = Schema.TaggedStruct("AgentLeftNamespace", {
  namespace: NamespaceId,
  agentId: AgentId,
  by: Schema.String,
  reason: Schema.Literals(["declined", "left", "withdrawn", "removed"]),
});

/** The events of an agent's place in a namespace, which the namespace's own object commits. */
export const NamespaceAgentEvent = Schema.Union([
  AgentInvited,
  AgentJoinedNamespace,
  AgentLeftNamespace,
]);
export type NamespaceAgentEvent = typeof NamespaceAgentEvent.Type;

/**
 * A person invited the agent to one project of their own namespace, and
 * answers for it there once it accepts. Until then it gives the agent nothing.
 */
export const AgentInvitedToProject = Schema.TaggedStruct("AgentInvitedToProject", {
  projectId: ProjectId,
  namespace: NamespaceId,
  agentId: AgentId,
  by: UserId,
  scopes: InvitationScopes,
});
/** The agent accepted: it stands on the project. Names no person, so whoever reads the project may read it. */
export const AgentJoinedProject = Schema.TaggedStruct("AgentJoinedProject", {
  projectId: ProjectId,
  namespace: NamespaceId,
  agentId: AgentId,
});
/** The invitation to the project ended: `by` and `reason` as `AgentLeftNamespace` gives them. */
export const AgentLeftProject = Schema.TaggedStruct("AgentLeftProject", {
  projectId: ProjectId,
  namespace: NamespaceId,
  agentId: AgentId,
  by: Schema.String,
  reason: Schema.Literals(["declined", "left", "withdrawn", "removed"]),
});

/** The events of an agent's place on one project, which the project's own object commits. */
export const ProjectAgentEvent = Schema.Union([
  AgentInvitedToProject,
  AgentJoinedProject,
  AgentLeftProject,
]);
export type ProjectAgentEvent = typeof ProjectAgentEvent.Type;

/** Every event of the Invitation machine: a namespace's three, and one project's three. */
export const InvitationEvent = Schema.Union([
  AgentInvited,
  AgentJoinedNamespace,
  AgentLeftNamespace,
  AgentInvitedToProject,
  AgentJoinedProject,
  AgentLeftProject,
]);
export type InvitationEvent = typeof InvitationEvent.Type;

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
  AgentInvited,
  AgentJoinedNamespace,
  AgentLeftNamespace,
  AgentInvitedToProject,
  AgentJoinedProject,
  AgentLeftProject,
  UserSignedUp,
  OrgCreated,
  MembershipChanged,
  UserSuspended,
  UserReinstated,
  OrgSuspended,
  OrgReinstated,
  OrgDeleted,
  SponsorRequested,
  SponsorRequestDeclined,
  SponsorBlockLifted,
]);
export type IdentityEvent = typeof IdentityEvent.Type;
