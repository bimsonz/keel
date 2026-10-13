import { Schema } from "effect";
import {
  type AgentId,
  agentActor,
  type Actor as EventActor,
  type OrgId,
  type ProjectId,
  userActor,
  type UserId,
} from "../kernel/index.ts";
import type { Scope } from "./agent.ts";

/**
 * A user's handle or an org's name: one segment of `/<org>/<project>`, unique
 * per instance across users and orgs, as on GitHub. Lower-case letters and
 * digits with single hyphens between them, at most 39 characters. The reserved
 * names are the (`names.ts`); this is only the shape.
 */
export const Handle = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:-?[a-z0-9]){0,38}$/));
export type Handle = typeof Handle.Type;

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

/** One of a user's memberships, as the Memberships port reads it from D1. */
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
 *   a role and is not suspended;
 * - `None`: it has no standing there, and is the public.
 *
 * A sponsor is no standing: the link between a person and an agent carries no
 * rights, so the policy never reads it of an agent.
 */
export type AgentStanding =
  | { readonly _tag: "Governs" }
  | { readonly _tag: "Invited"; readonly by: MemberStanding }
  | { readonly _tag: "None" };

/**
 * A Keel JWT: an agent acting as itself. The agent is tied to no project, but
 * each token is for one run in one namespace and at most one of its projects,
 * so the principal carries that namespace (`org`), the project when the token
 * names one, and the agent's standing there. A new agent's first token names
 * no project: it stands in its own namespace, where it makes its first.
 * `paused` is the Agent machine's `suspended` state: a paused agent has no
 * rights anywhere.
 */
export interface AgentPrincipal {
  readonly _tag: "Agent";
  readonly agentId: AgentId;
  readonly org: OrgId;
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
export const eventActorOf = (actor: Actor): EventActor =>
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
 * An org. `personOwned` says a person is among its owners: no agent governs
 * there, whatever its standing says.
 */
export interface OrgResource {
  readonly _tag: "Org";
  readonly org: OrgId;
  readonly suspended: boolean;
  readonly personOwned: boolean;
}

/**
 * A project, with what the policy needs to know about it. `personOwned` is its
 * org's: a person is among the owners. `sponsor` is the sponsor of the agent an
 * action concerns (a ruling on its escalation, its standing), when there is one.
 */
export interface ProjectResource {
  readonly _tag: "Project";
  readonly org: OrgId;
  readonly projectId: ProjectId;
  readonly visibility: Visibility;
  readonly orgSuspended: boolean;
  readonly personOwned: boolean;
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
  readonly target: OrgResource;
}

export type Resource =
  | InstanceResource
  | SelfResource
  | OrgResource
  | ProjectResource
  | MissingResource
  | ForkResource;
