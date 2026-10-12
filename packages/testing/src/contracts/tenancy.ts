import { describe, expect, it } from "@effect/vitest";
import type { Membership } from "@keeltown/core/domain/identity";
import { OrgId, ProjectId, UserId } from "@keeltown/core/kernel";
import { Memberships, Orgs, ProjectOrgs, Users } from "@keeltown/core/ports";
import { Clock, Effect, type Layer, Option, Schema } from "effect";
import type { BetterAuthRows } from "../memory/tenancy.ts";

/**
 * The suites of the ports that read Better Auth's rows seed those rows first,
 * as Better Auth's own endpoints would write them. A real adapter's tables
 * outlive one case, so every case uses fresh ids and names.
 */
export interface TenancyHarness<S> {
  readonly layer: Layer.Layer<S>;
  readonly seed: (rows: BetterAuthRows) => Effect.Effect<void>;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  [...crypto.getRandomValues(new Uint8Array(26))].map((b) => CROCKFORD[b % 32] ?? "0").join("");
const orgId = () => Schema.decodeUnknownSync(OrgId)(`org_${ulid()}`);
const userId = () => Schema.decodeUnknownSync(UserId)(`usr_${ulid()}`);
const projectId = () => Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
/** A fresh handle or org name: lower-case, as Better Auth holds both. */
const fresh = (stem: string) => `${stem}-${ulid().slice(0, 10).toLowerCase()}`;

/** Memberships in the order the ports answer them: by org id, as D1 orders text. */
const byOrg = (memberships: readonly Membership[]) =>
  memberships.toSorted((a, b) => (a.org < b.org ? -1 : a.org > b.org ? 1 : 0));

export function describeOrgsContract(adapter: string, make: () => TenancyHarness<Orgs>) {
  describe(`Orgs contract: ${adapter}`, () => {
    it.effect("[ports.orgs-unknown] finds no org by an id or a name it was not given", () => {
      const harness = make();
      return Effect.gen(function* () {
        const orgs = yield* Orgs;
        expect(Option.isNone(yield* orgs.byId(orgId()))).toBe(true);
        expect(Option.isNone(yield* orgs.byName(fresh("nobody")))).toBe(true);
      }).pipe(Effect.provide(harness.layer));
    });

    it.effect(
      "[ports.orgs-name] finds an org by its id and by its name in any case, with its suspension",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const active = { id: orgId(), slug: fresh("acme") };
          const suspended = { id: orgId(), slug: fresh("shut"), suspended: true };
          yield* harness.seed({ orgs: [active, suspended] });
          const orgs = yield* Orgs;
          const record = { org: active.id, name: active.slug, suspended: false };
          expect(yield* orgs.byId(active.id)).toEqual(Option.some(record));
          expect(yield* orgs.byName(active.slug)).toEqual(Option.some(record));
          expect(yield* orgs.byName(active.slug.toUpperCase())).toEqual(Option.some(record));
          expect(yield* orgs.byName(suspended.slug)).toEqual(
            Option.some({ org: suspended.id, name: suspended.slug, suspended: true }),
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}

export function describeUsersContract(adapter: string, make: () => TenancyHarness<Users>) {
  describe(`Users contract: ${adapter}`, () => {
    it.effect(
      "[ports.users-unknown] answers no principal for a user Better Auth does not know",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          expect(Option.isNone(yield* (yield* Users).principal(userId()))).toBe(true);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect("[ports.users-ban-lapsed] a ban suspends its user until it ends", () => {
      const harness = make();
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const ended = { id: userId(), banned: true, banExpires: new Date(now - 60_000) };
        const running = { id: userId(), banned: true, banExpires: new Date(now + 3_600_000) };
        yield* harness.seed({ users: [ended, running] });
        const users = yield* Users;
        const suspended = (id: UserId) =>
          Effect.map(
            users.principal(id),
            Option.map((principal) => principal.suspended),
          );
        expect(yield* suspended(ended.id)).toEqual(Option.some(false));
        expect(yield* suspended(running.id)).toEqual(Option.some(true));
      }).pipe(Effect.provide(harness.layer));
    });

    it.effect(
      "[ports.users-principal] answers a user's handle, whether it is suspended, and its memberships",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const ada = { id: userId(), username: fresh("ada") };
          const banned = { id: userId(), banned: true };
          const plain = { id: userId(), username: fresh("bo") };
          const first = { id: orgId(), slug: fresh("first") };
          const second = { id: orgId(), slug: fresh("second") };
          yield* harness.seed({
            users: [ada, banned, plain],
            orgs: [first, second],
            members: [
              { organizationId: first.id, userId: ada.id, role: "member" },
              { organizationId: second.id, userId: ada.id, role: "owner" },
              { organizationId: first.id, userId: plain.id, role: "maintainer" },
            ],
          });
          const users = yield* Users;
          expect(yield* users.principal(ada.id)).toEqual(
            Option.some({
              _tag: "User",
              userId: ada.id,
              handle: ada.username,
              suspended: false,
              memberships: byOrg([
                { org: first.id, role: "member" },
                { org: second.id, role: "owner" },
              ]),
            }),
          );
          // No handle chosen yet: the principal has none, not an empty one.
          const unnamed = yield* users.principal(banned.id);
          expect(unnamed).toEqual(
            Option.some({
              _tag: "User",
              userId: banned.id,
              suspended: true,
              memberships: [],
            }),
          );
          expect(Option.map(unnamed, (principal) => "handle" in principal)).toEqual(
            Option.some(false),
          );
          expect(
            Option.map(yield* users.principal(plain.id), (principal) => [
              principal.suspended,
              principal.memberships,
            ]),
          ).toEqual(Option.some([false, [{ org: first.id, role: "maintainer" }]]));
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[ports.users-roles] takes each membership's strongest role in any order stored, ignoring names that are no role",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const user = { id: userId(), username: fresh("cy") };
          const orgs = Array.from({ length: 4 }, () => ({ id: orgId(), slug: fresh("org") }));
          const [owned, maintained, joined, foreign] = orgs.map((org) => org.id);
          if (!owned || !maintained || !joined || !foreign) throw new Error("four orgs");
          yield* harness.seed({
            users: [user],
            orgs,
            members: [
              { organizationId: owned, userId: user.id, role: "member,owner" },
              { organizationId: maintained, userId: user.id, role: "maintainer, member" },
              { organizationId: joined, userId: user.id, role: "billing,member" },
              // A row naming no role Keel knows is no membership.
              { organizationId: foreign, userId: user.id, role: "billing" },
            ],
          });
          const principal = yield* (yield* Users).principal(user.id);
          expect(Option.map(principal, (p) => p.memberships)).toEqual(
            Option.some(
              byOrg([
                { org: owned, role: "owner" },
                { org: maintained, role: "maintainer" },
                { org: joined, role: "member" },
              ]),
            ),
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}

export function describeMembershipsContract(
  adapter: string,
  make: () => TenancyHarness<Memberships>,
) {
  describe(`Memberships contract: ${adapter}`, () => {
    it.effect(
      "[ports.memberships-standing] answers a sponsor's strongest role in the org, and whether it is suspended",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const banned = { id: userId(), username: fresh("dee"), banned: true };
          const owner = { id: userId(), username: fresh("eve"), banned: false };
          const org = { id: orgId(), slug: fresh("team") };
          yield* harness.seed({
            users: [banned, owner],
            orgs: [org],
            members: [
              { organizationId: org.id, userId: banned.id, role: "member,maintainer" },
              { organizationId: org.id, userId: owner.id, role: "owner" },
            ],
          });
          const memberships = yield* Memberships;
          expect(yield* memberships.standing(banned.id, org.id)).toEqual({
            userId: banned.id,
            role: "maintainer",
            suspended: true,
          });
          expect(yield* memberships.standing(owner.id, org.id)).toEqual({
            userId: owner.id,
            role: "owner",
            suspended: false,
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[ports.memberships-ban-lapsed] a sponsor's ban suspends it until the ban ends",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const ended = { id: userId(), banned: true, banExpires: new Date(now - 60_000) };
          const running = { id: userId(), banned: true, banExpires: new Date(now + 3_600_000) };
          const org = { id: orgId(), slug: fresh("bans") };
          yield* harness.seed({
            users: [ended, running],
            orgs: [org],
            members: [
              { organizationId: org.id, userId: ended.id, role: "member" },
              { organizationId: org.id, userId: running.id, role: "member" },
            ],
          });
          const memberships = yield* Memberships;
          expect((yield* memberships.standing(ended.id, org.id)).suspended).toBe(false);
          expect((yield* memberships.standing(running.id, org.id)).suspended).toBe(true);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[ports.memberships-none] answers no role in an org the user is not in, whatever its others, and an unknown user unsuspended",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const user = { id: userId(), username: fresh("fay"), banned: true };
          const own = { id: orgId(), slug: fresh("own") };
          const other = { id: orgId(), slug: fresh("other") };
          yield* harness.seed({
            users: [user],
            orgs: [own, other],
            members: [{ organizationId: own.id, userId: user.id, role: "owner" }],
          });
          const memberships = yield* Memberships;
          const outside = yield* memberships.standing(user.id, other.id);
          expect(outside).toEqual({ userId: user.id, suspended: true });
          expect("role" in outside).toBe(false);
          const stranger = userId();
          expect(yield* memberships.standing(stranger, own.id)).toEqual({
            userId: stranger,
            suspended: false,
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}

export function describeProjectOrgsContract(adapter: string, make: () => Layer.Layer<ProjectOrgs>) {
  describe(`ProjectOrgs contract: ${adapter}`, () => {
    it.effect(
      "[ports.project-orgs-unknown] finds no place for a project or a name it was not given, and none in an empty org",
      () =>
        Effect.gen(function* () {
          const projects = yield* ProjectOrgs;
          const org = orgId();
          expect(Option.isNone(yield* projects.byId(projectId()))).toBe(true);
          expect(Option.isNone(yield* projects.byName(org, fresh("app")))).toBe(true);
          expect(yield* projects.inOrg(org)).toEqual([]);
        }).pipe(Effect.provide(make())),
    );

    it.effect(
      "[ports.project-orgs-assign] places a project, found by id and by its name in any case, and assigning that place again succeeds",
      () =>
        Effect.gen(function* () {
          const projects = yield* ProjectOrgs;
          const name = fresh("app");
          const asked = { projectId: projectId(), org: orgId(), name: name.toUpperCase() };
          yield* projects.assign(asked);
          const place = { ...asked, name };
          expect(yield* projects.byId(asked.projectId)).toEqual(Option.some(place));
          expect(yield* projects.byName(asked.org, name)).toEqual(Option.some(place));
          expect(yield* projects.byName(asked.org, asked.name)).toEqual(Option.some(place));
          yield* projects.assign(asked);
          yield* projects.assign(place);
          expect(yield* projects.inOrg(asked.org)).toEqual([place]);
        }).pipe(Effect.provide(make())),
    );

    it.effect(
      "[ports.project-orgs-taken] refuses a name the org holds, in any case, and another place for a placed project, with ProjectNameTaken",
      () =>
        Effect.gen(function* () {
          const projects = yield* ProjectOrgs;
          const org = orgId();
          const elsewhere = orgId();
          const name = fresh("app");
          const placed = { projectId: projectId(), org, name };
          yield* projects.assign(placed);
          const rival = projectId();
          expect(
            yield* Effect.flip(
              projects.assign({ projectId: rival, org, name: name.toUpperCase() }),
            ),
          ).toMatchObject({ _tag: "ProjectNameTaken", org, name });
          const renamed = fresh("renamed");
          expect(yield* Effect.flip(projects.assign({ ...placed, name: renamed }))).toMatchObject({
            _tag: "ProjectNameTaken",
            org,
            name: renamed,
          });
          expect(yield* Effect.flip(projects.assign({ ...placed, org: elsewhere }))).toMatchObject({
            _tag: "ProjectNameTaken",
            org: elsewhere,
            name,
          });
          expect(yield* projects.byId(placed.projectId)).toEqual(Option.some(placed));
          expect(Option.isNone(yield* projects.byId(rival))).toBe(true);
          // The same name in another org is another project's to take.
          yield* projects.assign({ projectId: rival, org: elsewhere, name });
          expect(yield* projects.byName(elsewhere, name)).toEqual(
            Option.some({ projectId: rival, org: elsewhere, name }),
          );
        }).pipe(Effect.provide(make())),
    );

    it.effect("[ports.project-orgs-in-org] lists an org's projects by name, and only its own", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectOrgs;
        const org = orgId();
        const stem = fresh("p");
        const places = ["b", "c", "a"].map((suffix) => ({
          projectId: projectId(),
          org,
          name: `${stem}-${suffix}`,
        }));
        for (const place of places) yield* projects.assign(place);
        yield* projects.assign({ projectId: projectId(), org: orgId(), name: `${stem}-a` });
        expect((yield* projects.inOrg(org)).map((place) => place.name)).toEqual(
          ["a", "b", "c"].map((suffix) => `${stem}-${suffix}`),
        );
      }).pipe(Effect.provide(make())),
    );

    it.effect(
      "[ports.project-orgs-all] pages every org's projects by id, after a cursor and up to a limit",
      () =>
        Effect.gen(function* () {
          const projects = yield* ProjectOrgs;
          const stem = fresh("all");
          const places = [orgId(), orgId(), orgId()].map((org, i) => ({
            projectId: projectId(),
            org,
            name: `${stem}-${i}`,
          }));
          for (const place of places) yield* projects.assign(place);
          const ours = (list: readonly { readonly projectId: string }[]) =>
            list.filter((place) => places.some((p) => p.projectId === place.projectId));
          const ids = places.map((place) => place.projectId).toSorted();
          const first = yield* projects.all(undefined, 10_000);
          expect(ours(first).map((place) => place.projectId)).toEqual(ids);
          const [one, two] = ids;
          expect(ours(yield* projects.all(one, 10_000)).map((p) => p.projectId)).toEqual(
            ids.slice(1),
          );
          const page = yield* projects.all(undefined, 1);
          expect(page).toHaveLength(1);
          expect(two).toBeDefined();
        }).pipe(Effect.provide(make())),
    );
  });
}
