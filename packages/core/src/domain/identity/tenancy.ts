import { Schema } from "effect";
import {
  type AgentId,
  agentActor,
  type CommandActor,
  type NamespaceId,
  type NamespaceKind,
  type OrgId,
  type ProjectId,
  userActor,
  type UserId,
} from "../kernel/index.ts";
import type { Scope } from "./agent.ts";
import { Handle } from "./handle.ts";

export { Handle };

/**
 * A member's role in an org. Each includes the one
 * below it: `owner` holds members, deploy targets, credentials and deletion;
 * `maintainer` projects, settings, agents' standing and rulings; `member` reads
 * the org's private projects and sponsors agents.
 */
export const Role = Schema.Literals(["owner", "maintainer", "member"]);
export type Role = typeof Role.Type;

/**
 * The strongest role among `names` (a member's roles, which Better Auth may
 * hold several of): `Role` lists them strongest first. A name that is no role
 * is ignored, so none at all answers undefined.
 */
export const strongestRole = (names: readonly string[]): Role | undefined =>
  Role.literals.find((role) => names.includes(role));

/**
 * Whether a ban still suspends its user at `now`: Better Auth's bans may carry
 * an end (`banExpires`), and a user whose ban has ended is no longer suspended.
 */
export const banHolds = (banned: boolean, banExpires: Date | undefined, now: number): boolean =>
  banned && (banExpires === undefined || banExpires.getTime() > now);

/**
 * One of a user's memberships in an org, as the Users port reads it from D1.
 * A user's own namespace is never among them: it has no members, and its
 * owner holds it by identity.
 */
export interface Membership {
  readonly org: OrgId;
  readonly role: Role;
}

export const Visibility = Schema.Literals(["private", "public"]);
export type Visibility = typeof Visibility.Type;

/**
 * Who is asking, as the gate builds it from the request and the Memberships
 * port. `authorize` decides from this alone and never reads events.
 */
export type Principal = UserPrincipal | AgentPrincipal | AnonymousPrincipal;

/** A Better Auth session. A user without a handle may only choose one. */
export interface UserPrincipal {
  readonly _tag: "User";
  readonly userId: UserId;
  readonly handle?: Handle;
  readonly suspended: boolean;
  readonly memberships: readonly Membership[];
}

/**
 * A user's standing in an org, as the gate reads it now: `role` is the user's
 * strongest role there, absent once the user has left it.
 */
export interface MemberStanding {
  readonly userId: UserId;
  readonly role?: Role;
  readonly suspended: boolean;
}

/**
 * Where an agent stands in the namespace its token is for:
 * - `Governs`: the namespace is the agent's own, or an org it created;
 * - `Invited`: a member invited it there and answers for it. `by` is that
 *   member's standing now, so an invitation counts only while its inviter holds
 *   a role and is not suspended. `projectOnly` says the invitation is to the
 *   token's project alone (a person's own namespace takes an agent on one
 *   project): the rest of the namespace is to the agent what it is to anyone;
 * - `None`: it has no standing there, and is the public.
 *
 * A sponsor is no standing: the link between a person and an agent carries no
 * rights, so the policy never reads it of an agent.
 */
export type AgentStanding =
  | { readonly _tag: "Governs" }
  | { readonly _tag: "Invited"; readonly by: MemberStanding; readonly projectOnly?: boolean }
  | { readonly _tag: "None" };

/**
 * A Keel JWT: an agent acting as itself. The agent is tied to no project, but
 * each token is for one run in one namespace and at most one of its projects,
 * so the principal carries that namespace, the project when the token names
 * one, and the agent's standing there. A new agent's first token names
 * no project: it stands in its own namespace, where it makes its first.
 * `paused` is the Agent machine's `suspended` state: a paused agent has no
 * rights anywhere.
 */
export interface AgentPrincipal {
  readonly _tag: "Agent";
  readonly agentId: AgentId;
  readonly namespace: NamespaceId;
  readonly projectId?: ProjectId;
  readonly scopes: readonly Scope[];
  readonly paused: boolean;
  readonly standing: AgentStanding;
}

export interface AnonymousPrincipal {
  readonly _tag: "Anonymous";
}

/**
 * Who a granted command is by, as a use-case records it: the agent or the user
 * the policy already granted. It decides nothing; it names.
 */
export type Actor =
  | { readonly _tag: "Agent"; readonly agentId: AgentId }
  | { readonly _tag: "User"; readonly userId: UserId };

/** The actor's id: its agent's or its user's. */
export const actorId = (actor: Actor): string =>
  actor._tag === "Agent" ? actor.agentId : actor.userId;

/** The actor as an event's envelope names it: `agent:<id>` or `user:<id>`. */
export const eventActorOf = (actor: Actor): CommandActor =>
  actor._tag === "Agent" ? agentActor(actor.agentId) : userActor(actor.userId);

/** The instance itself: what is asked of no org, project or account, such as signing in or creating an org. */
export interface InstanceResource {
  readonly _tag: "Instance";
}

/** The caller's own record: its handle, its identity, its inbox. */
export interface SelfResource {
  readonly _tag: "Self";
}

/**
 * Whether a person owns a namespace of this kind: a person's own and an org
 * are people's, an agent's own is the agent's.
 */
export const personOwns = (kind: NamespaceKind): boolean => kind !== "agent";

/**
 * A namespace: a person's own, an agent's own, or an org. Its id says which
 * (`namespaceKind`), so no field repeats it. Only an org has members, so the
 * actions on members and on deleting it are decided on an org alone.
 * `personOwned` says a person is among its owners: no agent governs there,
 * whatever its standing says. `inviter` is the member who invited the agent an
 * action concerns into it (taking that agent out again), when one did.
 */
export interface NamespaceResource {
  readonly _tag: "Namespace";
  readonly namespace: NamespaceId;
  readonly suspended: boolean;
  readonly personOwned: boolean;
  readonly inviter?: UserId;
}

/**
 * A project, with what the policy needs to know about it. `personOwned` is its
 * namespace's: a person is among the owners. `sponsor` is the sponsor of the agent an
 * action concerns (a ruling on its escalation, its standing), when there is one.
 */
export interface ProjectResource {
  readonly _tag: "Project";
  readonly namespace: NamespaceId;
  readonly projectId: ProjectId;
  readonly visibility: Visibility;
  readonly namespaceSuspended: boolean;
  readonly personOwned: boolean;
  readonly sponsor?: UserId;
}

/**
 * An agent's own account, with the person who sponsors it when there is
 * one. It belongs to no org: what is decided on it is between the agent and its
 * sponsor, and to everyone else it is not there.
 */
export interface AgentResource {
  readonly _tag: "Agent";
  readonly agentId: AgentId;
  readonly sponsor?: UserId;
}

/** Nothing by that name. Answered exactly as a private resource the caller cannot see. */
export interface MissingResource {
  readonly _tag: "Missing";
}

/** Forking `source` into a new project in `target`. */
export interface ForkResource {
  readonly _tag: "Fork";
  readonly source: ProjectResource | MissingResource;
  readonly target: NamespaceResource;
}

export type Resource =
  | InstanceResource
  | SelfResource
  | NamespaceResource
  | ProjectResource
  | AgentResource
  | MissingResource
  | ForkResource;
