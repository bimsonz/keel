import { Schema } from "effect";
import type { AgentId, OrgId, ProjectId, UserId } from "../kernel/index.ts";
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
export type Principal = UserPrincipal | AgentPrincipal | AnonymousPrincipal | BootstrapPrincipal;

/** A Better Auth session. A user without a handle may only choose one. */
export interface UserPrincipal {
  readonly _tag: "User";
  readonly userId: UserId;
  readonly handle?: Handle;
  readonly instanceAdmin: boolean;
  readonly suspended: boolean;
  readonly memberships: readonly Membership[];
}

/**
 * The user who minted an agent's credential, as the gate reads it now: `role`
 * is the sponsor's role in the agent's org, absent once the sponsor has left it.
 */
export interface SponsorStanding {
  readonly userId: UserId;
  readonly role?: Role;
  readonly suspended: boolean;
}

/** A Keel JWT: an agent confined to one project of one org, never exceeding its sponsor. */
export interface AgentPrincipal {
  readonly _tag: "Agent";
  readonly agentId: AgentId;
  readonly org: OrgId;
  readonly projectId: ProjectId;
  readonly scopes: readonly Scope[];
  readonly sponsor: SponsorStanding;
}

export interface AnonymousPrincipal {
  readonly _tag: "Anonymous";
}

/**
 * The bootstrap credential (`bootstrap.ts`): how a new deployment gets its
 * first user. It may call exactly `BOOTSTRAP_ACTIONS`.
 */
export interface BootstrapPrincipal {
  readonly _tag: "Bootstrap";
}

/** The instance itself: its quotas, its users, its spend. */
export interface InstanceResource {
  readonly _tag: "Instance";
}

/** The caller's own record: its handle, its identity, its inbox. */
export interface SelfResource {
  readonly _tag: "Self";
}

export interface OrgResource {
  readonly _tag: "Org";
  readonly org: OrgId;
  readonly suspended: boolean;
}

/**
 * A project, with what the policy needs to know about it. `sponsor` is the
 * sponsor of the agent an action concerns (a ruling on its escalation, its
 * standing), when there is one.
 */
export interface ProjectResource {
  readonly _tag: "Project";
  readonly org: OrgId;
  readonly projectId: ProjectId;
  readonly visibility: Visibility;
  readonly orgSuspended: boolean;
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
