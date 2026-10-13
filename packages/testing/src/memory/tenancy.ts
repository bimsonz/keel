import {
  banHolds,
  Handle,
  type Membership,
  ProjectNameTaken,
  strongestRole,
  type Visibility,
} from "@keeltown/core/domain/identity";
import type { AgentId, NamespaceId, OrgId, UserId } from "@keeltown/core/kernel";
import {
  Memberships,
  type ListedProject,
  type NamespaceRecord,
  Namespaces,
  type ProjectPlace,
  ProjectNamespaces,
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

/** A `member` row: `role` may name several roles, comma-separated. Its org is an organization's id alone, as the table's foreign key holds it. */
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
  /** The agents' own namespaces, which no Better Auth row stands for: the handle each agent holds. */
  const agents = new Map<AgentId, Handle>();
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
        const org = member.organizationId;
        return role === undefined ? [] : [{ org, role }];
      })
      .toSorted((a, b) => binary(a.org, b.org));
  return { users, orgs, members, agents, seed, membershipsOf };
}

export type BetterAuthMemory = ReturnType<typeof makeBetterAuthMemory>;

/**
 * Every namespace the rows make, as the `namespaces` table holds them: one for
 * each user with a handle, by the user's id, one for each org, by its id, and
 * one for each agent that signed itself up, by the agent's id.
 */
const namespacesOf = (rows: BetterAuthMemory, now: number): readonly NamespaceRecord[] => [
  ...[...rows.users.values()].flatMap((user): NamespaceRecord[] =>
    user.username === undefined
      ? []
      : [
          {
            namespace: user.id,
            handle: decodeHandle(user.username),
            kind: "user",
            suspended: banHolds(user.banned === true, user.banExpires, now),
          },
        ],
  ),
  ...[...rows.orgs.values()].map((org): NamespaceRecord => ({
    namespace: org.id,
    handle: decodeHandle(org.slug),
    kind: "org",
    suspended: org.suspended === true,
  })),
  ...[...rows.agents].map(([agent, handle]): NamespaceRecord => ({
    namespace: agent,
    handle,
    kind: "agent",
    suspended: false,
  })),
];

/** Namespaces over Better Auth's rows in memory. */
export function makeNamespacesMemory(rows: BetterAuthMemory = makeBetterAuthMemory()) {
  const find = (matches: (record: NamespaceRecord) => boolean) =>
    Effect.map(Clock.currentTimeMillis, (now) =>
      Option.fromNullishOr(namespacesOf(rows, now).find(matches)),
    );
  return {
    seed: rows.seed,
    layer: Layer.succeed(
      Namespaces,
      Namespaces.of({
        byId: (namespace) => find((record) => record.namespace === namespace),
        byHandle: (handle) => find((record) => record.handle === handle.toLowerCase()),
        holdForAgent: (agent, handle) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            const held = decodeHandle(handle.toLowerCase());
            const holder = namespacesOf(rows, now).find((record) => record.handle === held);
            if (holder === undefined) rows.agents.set(agent, held);
            return holder === undefined || holder.namespace === agent;
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
        standing: (userId, namespace) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            const user = rows.users.get(userId);
            const own = user === undefined ? undefined : ("owner" as const);
            const role =
              namespace === userId
                ? own
                : rows.membershipsOf(userId).find((m) => m.org === namespace)?.role;
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

/** A project's namespace and name, in any case: what the `projects` table holds unique. */
const nameKey = (namespace: NamespaceId, name: string) => `${namespace}\u0000${name.toLowerCase()}`;

/**
 * Projects' places in a map, with the `projects` table's unique (namespace,
 * name), and each one's mirrored visibility with the seq that wrote it. A
 * list reads the namespaces Better Auth's rows make, as the table's join does.
 */
export function makeProjectNamespacesMemory(rows: BetterAuthMemory = makeBetterAuthMemory()) {
  const places = new Map<string, ProjectPlace>();
  const mirrored = new Map<string, { readonly visibility: Visibility; readonly seq: number }>();
  const byName = (namespace: NamespaceId, name: string) =>
    [...places.values()].find(
      (place) => nameKey(place.namespace, place.name) === nameKey(namespace, name),
    );
  return {
    places,
    seed: rows.seed,
    layer: Layer.succeed(
      ProjectNamespaces,
      ProjectNamespaces.of({
        assign: (place) =>
          Effect.suspend(() => {
            const name = place.name.toLowerCase();
            const taken = Effect.fail(new ProjectNameTaken({ namespace: place.namespace, name }));
            const held = places.get(place.projectId);
            if (held !== undefined)
              return held.namespace === place.namespace && held.name === name ? Effect.void : taken;
            if (byName(place.namespace, name) !== undefined) return taken;
            places.set(place.projectId, { ...place, name });
            return Effect.void;
          }),
        release: (projectId) =>
          Effect.sync(() => {
            places.delete(projectId);
            mirrored.delete(projectId);
          }),
        byId: (projectId) => Effect.sync(() => Option.fromNullishOr(places.get(projectId))),
        byName: (namespace, name) =>
          Effect.sync(() => Option.fromNullishOr(byName(namespace, name))),
        inNamespace: (namespace) =>
          Effect.sync(() =>
            [...places.values()]
              .filter((place) => place.namespace === namespace)
              .toSorted((a, b) => binary(a.name, b.name)),
          ),
        shownTo: (audience, after, limit) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            const namespaces = namespacesOf(rows, now);
            return [...places.values()]
              .filter((place) => after === undefined || binary(place.projectId, after) > 0)
              .toSorted((a, b) => binary(a.projectId, b.projectId))
              .flatMap((place): ListedProject[] => {
                const held = namespaces.find((record) => record.namespace === place.namespace);
                if (held === undefined) return [];
                const visibility = mirrored.get(place.projectId)?.visibility ?? "private";
                const shown =
                  visibility === "public" ||
                  audience.namespaces.includes(place.namespace) ||
                  audience.project === place.projectId;
                const { handle, kind, suspended } = held;
                return shown ? [{ ...place, visibility, handle, kind, suspended }] : [];
              })
              .slice(0, limit);
          }),
        visibility: (projectId, visibility, seq) =>
          Effect.sync(() => {
            if (!places.has(projectId)) return;
            if ((mirrored.get(projectId)?.seq ?? 0) < seq)
              mirrored.set(projectId, { visibility, seq });
          }),
      }),
    ),
  };
}
