import {
  banHolds,
  Handle,
  type Membership,
  ProjectNameTaken,
  strongestRole,
} from "@keeltown/core/domain/identity";
import type { OrgId, UserId } from "@keeltown/core/kernel";
import {
  Memberships,
  type OrgRecord,
  Orgs,
  type ProjectPlace,
  ProjectOrgs,
  Users,
} from "@keeltown/core/ports";
import { Clock, Effect, Layer, Option, Schema } from "effect";

/** A `user` row as Better Auth writes it, with only the columns tenancy reads. */
export interface BetterAuthUser {
  readonly id: UserId;
  /** The handle, once chosen. */
  readonly username?: string;
  readonly banned?: boolean;
  /** When the ban ends; absent, it holds until lifted. */
  readonly banExpires?: Date;
}

/** An `organization` row: `slug` is the org's name, lower-case. */
export interface BetterAuthOrg {
  readonly id: OrgId;
  readonly slug: string;
  readonly suspended?: boolean;
}

/** A `member` row: `role` may name several roles, comma-separated. */
export interface BetterAuthMember {
  readonly organizationId: OrgId;
  readonly userId: UserId;
  readonly role: string;
}

/** Rows to seed, in the order a suite gives them: users and orgs before their members. */
export interface BetterAuthRows {
  readonly users?: readonly BetterAuthUser[];
  readonly orgs?: readonly BetterAuthOrg[];
  readonly members?: readonly BetterAuthMember[];
}

/** SQLite's default collation: by code unit, as D1 orders. */
const binary = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A comma-separated role column, as names. */
const rolesOf = (column: string | undefined): readonly string[] =>
  (column ?? "").split(",").map((role) => role.trim());

const decodeHandle = Schema.decodeUnknownSync(Handle);

/**
 * Better Auth's users, orgs and members in maps, as its tables hold them.
 * `seed` writes rows as Better Auth would; the tenancy adapters below read
 * them as the D1 ones read the tables.
 */
export function makeBetterAuthMemory(rows: BetterAuthRows = {}) {
  const users = new Map<UserId, BetterAuthUser>();
  const orgs = new Map<OrgId, BetterAuthOrg>();
  const members: BetterAuthMember[] = [];
  const seed = (more: BetterAuthRows): void => {
    for (const user of more.users ?? []) users.set(user.id, user);
    for (const org of more.orgs ?? []) orgs.set(org.id, org);
    members.push(...(more.members ?? []));
  };
  seed(rows);
  /** The user's memberships, each at its strongest role, in org id order. */
  const membershipsOf = (userId: UserId): readonly Membership[] =>
    members
      .filter((member) => member.userId === userId)
      .flatMap((member) => {
        const role = strongestRole(rolesOf(member.role));
        return role === undefined ? [] : [{ org: member.organizationId, role }];
      })
      .toSorted((a, b) => binary(a.org, b.org));
  return { users, orgs, members, seed, membershipsOf };
}

export type BetterAuthMemory = ReturnType<typeof makeBetterAuthMemory>;

const recordOf = (org: BetterAuthOrg): OrgRecord => ({
  org: org.id,
  name: org.slug,
  suspended: org.suspended === true,
});

/** Orgs over Better Auth's rows in memory. */
export function makeOrgsMemory(rows: BetterAuthMemory = makeBetterAuthMemory()) {
  return {
    seed: rows.seed,
    layer: Layer.succeed(
      Orgs,
      Orgs.of({
        byId: (org) =>
          Effect.sync(() => Option.map(Option.fromNullishOr(rows.orgs.get(org)), recordOf)),
        byName: (name) =>
          Effect.sync(() => {
            const lowered = name.toLowerCase();
            return Option.map(
              Option.fromNullishOr([...rows.orgs.values()].find((org) => org.slug === lowered)),
              recordOf,
            );
          }),
      }),
    ),
  };
}

/** Users over Better Auth's rows in memory. */
export function makeUsersMemory(rows: BetterAuthMemory = makeBetterAuthMemory()) {
  return {
    seed: rows.seed,
    layer: Layer.succeed(
      Users,
      Users.of({
        principal: (userId) =>
          Effect.map(Clock.currentTimeMillis, (now) =>
            Option.map(Option.fromNullishOr(rows.users.get(userId)), (user) => ({
              _tag: "User" as const,
              userId: user.id,
              ...(user.username === undefined ? {} : { handle: decodeHandle(user.username) }),
              suspended: banHolds(user.banned === true, user.banExpires, now),
              memberships: rows.membershipsOf(user.id),
            })),
          ),
      }),
    ),
  };
}

/** Memberships over Better Auth's rows in memory. */
export function makeMembershipsMemory(rows: BetterAuthMemory = makeBetterAuthMemory()) {
  return {
    seed: rows.seed,
    layer: Layer.succeed(
      Memberships,
      Memberships.of({
        standing: (userId, org) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            const role = rows.membershipsOf(userId).find((m) => m.org === org)?.role;
            const user = rows.users.get(userId);
            return {
              userId,
              ...(role === undefined ? {} : { role }),
              suspended: banHolds(user?.banned === true, user?.banExpires, now),
            };
          }),
      }),
    ),
  };
}

/** A project's org and name, in any case: what the `projects` table holds unique. */
const nameKey = (org: OrgId, name: string) => `${org}\u0000${name.toLowerCase()}`;

/** Projects' places in a map, with the `projects` table's unique (org, name). */
export function makeProjectOrgsMemory() {
  const places = new Map<string, ProjectPlace>();
  const byName = (org: OrgId, name: string) =>
    [...places.values()].find((place) => nameKey(place.org, place.name) === nameKey(org, name));
  return {
    places,
    layer: Layer.succeed(
      ProjectOrgs,
      ProjectOrgs.of({
        assign: (place) =>
          Effect.suspend(() => {
            const name = place.name.toLowerCase();
            const taken = Effect.fail(new ProjectNameTaken({ org: place.org, name }));
            const held = places.get(place.projectId);
            if (held !== undefined)
              return held.org === place.org && held.name === name ? Effect.void : taken;
            if (byName(place.org, name) !== undefined) return taken;
            places.set(place.projectId, { ...place, name });
            return Effect.void;
          }),
        byId: (projectId) => Effect.sync(() => Option.fromNullishOr(places.get(projectId))),
        byName: (org, name) => Effect.sync(() => Option.fromNullishOr(byName(org, name))),
        inOrg: (org) =>
          Effect.sync(() =>
            [...places.values()]
              .filter((place) => place.org === org)
              .toSorted((a, b) => binary(a.name, b.name)),
          ),
        all: (after, limit) =>
          Effect.sync(() =>
            [...places.values()]
              .filter((place) => after === undefined || binary(place.projectId, after) > 0)
              .toSorted((a, b) => binary(a.projectId, b.projectId))
              .slice(0, limit),
          ),
      }),
    ),
  };
}
