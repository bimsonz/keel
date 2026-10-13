import { describe, expect, it } from "@effect/vitest";
import { Handle, type Membership, type ProjectAudience } from "@keeltown/core/domain/identity";
import { AgentId, type NamespaceId, OrgId, ProjectId, UserId } from "@keeltown/core/kernel";
import { Memberships, Namespaces, ProjectNamespaces, Users } from "@keeltown/core/ports";
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
const agentId = () => Schema.decodeUnknownSync(AgentId)(`agt_${ulid()}`);
const projectId = () => Schema.decodeUnknownSync(ProjectId)(`prj_${ulid()}`);
/** A fresh handle or org name: lower-case, as Better Auth holds both. */
const fresh = (stem: string) => `${stem}-${ulid().slice(0, 10).toLowerCase()}`;

/** Memberships in the order the ports answer them: by org id, as D1 orders text. */
const byOrg = (memberships: readonly Membership[]) =>
  memberships.toSorted((a, b) => (a.org < b.org ? -1 : a.org > b.org ? 1 : 0));

export function describeNamespacesContract(
  adapter: string,
  make: () => TenancyHarness<Namespaces>,
) {
  describe(`Namespaces contract: ${adapter}`, () => {
    it.effect(
      "[ports.namespaces-unknown] finds no namespace by an id or a handle it was not given",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const namespaces = yield* Namespaces;
          expect(Option.isNone(yield* namespaces.byId(orgId()))).toBe(true);
          expect(Option.isNone(yield* namespaces.byId(userId()))).toBe(true);
          expect(Option.isNone(yield* namespaces.byHandle(fresh("nobody")))).toBe(true);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[ports.namespaces-org] finds an org by its id and by its handle in any case, of kind org, with its suspension",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const active = { id: orgId(), slug: fresh("acme") };
          const suspended = { id: orgId(), slug: fresh("shut"), suspended: true };
          yield* harness.seed({ orgs: [active, suspended] });
          const namespaces = yield* Namespaces;
          const record = {
            namespace: active.id,
            handle: active.slug,
            kind: "org",
            suspended: false,
          };
          expect(yield* namespaces.byId(active.id)).toEqual(Option.some(record));
          expect(yield* namespaces.byHandle(active.slug)).toEqual(Option.some(record));
          expect(yield* namespaces.byHandle(active.slug.toUpperCase())).toEqual(
            Option.some(record),
          );
          expect(yield* namespaces.byHandle(suspended.slug)).toEqual(
            Option.some({
              namespace: suspended.id,
              handle: suspended.slug,
              kind: "org",
              suspended: true,
            }),
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[ports.namespaces-user] a person with a handle is a namespace of kind user under their own id, suspended while their ban holds; one with no handle is none",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const ada = { id: userId(), username: fresh("ada") };
          const banned = { id: userId(), username: fresh("bad"), banned: true };
          const lapsed = {
            id: userId(),
            username: fresh("back"),
            banned: true,
            banExpires: new Date(now - 60_000),
          };
          const unnamed = { id: userId() };
          yield* harness.seed({ users: [ada, banned, lapsed, unnamed] });
          const namespaces = yield* Namespaces;
          const record = {
            namespace: ada.id,
            handle: ada.username,
            kind: "user",
            suspended: false,
          };
          expect(yield* namespaces.byId(ada.id)).toEqual(Option.some(record));
          expect(yield* namespaces.byHandle(ada.username.toUpperCase())).toEqual(
            Option.some(record),
          );
          expect(yield* namespaces.byHandle(banned.username)).toEqual(
            Option.some({
              namespace: banned.id,
              handle: banned.username,
              kind: "user",
              suspended: true,
            }),
          );
          expect(Option.map(yield* namespaces.byId(lapsed.id), (found) => found.suspended)).toEqual(
            Option.some(false),
          );
          expect(Option.isNone(yield* namespaces.byId(unnamed.id))).toBe(true);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[ports.namespaces-agent] an agent holds a handle as its own namespace of kind agent, and holds it again; a handle another agent, a person or an org holds is refused and stays theirs",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const ada = { id: userId(), username: fresh("ada") };
          const acme = { id: orgId(), slug: fresh("acme") };
          yield* harness.seed({ users: [ada], orgs: [acme] });
          const namespaces = yield* Namespaces;
          const agent = agentId();
          const other = agentId();
          const handle = Schema.decodeUnknownSync(Handle)(fresh("agent"));
          expect(yield* namespaces.holdForAgent(agent, handle)).toBe(true);
          const record = { namespace: agent, handle, kind: "agent", suspended: false };
          expect(yield* namespaces.byId(agent)).toEqual(Option.some(record));
          expect(yield* namespaces.byHandle(handle.toUpperCase())).toEqual(Option.some(record));
          expect(yield* namespaces.holdForAgent(agent, handle)).toBe(true);
          for (const held of [handle, ada.username, acme.slug])
            expect([
              held,
              yield* namespaces.holdForAgent(other, Schema.decodeUnknownSync(Handle)(held)),
            ]).toEqual([held, false]);
          const holderOf = (held: string) =>
            Effect.map(
              namespaces.byHandle(held),
              Option.map((found) => found.namespace),
            );
          expect(yield* holderOf(handle)).toEqual(Option.some(agent));
          expect(yield* holderOf(ada.username)).toEqual(Option.some(ada.id));
          expect(yield* holderOf(acme.slug)).toEqual(Option.some(acme.id));
          expect(Option.isNone(yield* namespaces.byId(other))).toBe(true);
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
      "[ports.memberships-own] a person is the owner of the namespace whose id is their own, by no member row, and nobody else has a role there",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const ada = { id: userId(), username: fresh("ada") };
          const guest = { id: userId(), username: fresh("guest") };
          // No member row can name her namespace: the member table's foreign key takes an organization's id alone.
          yield* harness.seed({ users: [ada, guest] });
          const memberships = yield* Memberships;
          expect(yield* memberships.standing(ada.id, ada.id)).toEqual({
            userId: ada.id,
            role: "owner",
            suspended: false,
          });
          const visiting = yield* memberships.standing(guest.id, ada.id);
          expect(visiting).toEqual({ userId: guest.id, suspended: false });
          expect("role" in visiting).toBe(false);
          // A person who is gone owns nothing: their own id gives them no role.
          const gone = userId();
          expect("role" in (yield* memberships.standing(gone, gone))).toBe(false);
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

/** The ids of the given places, in the order a list answers them. */
const ids = (...places: readonly { readonly projectId: string }[]) =>
  places.map((each) => each.projectId).toSorted();
const idsOf = (rows: readonly { readonly projectId: string }[]) => rows.map((row) => row.projectId);

export function describeProjectNamespacesContract(
  adapter: string,
  make: () => TenancyHarness<ProjectNamespaces>,
) {
  describe(`ProjectNamespaces contract: ${adapter}`, () => {
    it.effect(
      "[ports.project-namespaces-unknown] finds no place for a project or a name it was not given, and none in an empty namespace",
      () =>
        Effect.gen(function* () {
          const projects = yield* ProjectNamespaces;
          const org = orgId();
          expect(Option.isNone(yield* projects.byId(projectId()))).toBe(true);
          expect(Option.isNone(yield* projects.byName(org, fresh("app")))).toBe(true);
          expect(yield* projects.inNamespace(org)).toEqual([]);
        }).pipe(Effect.provide(make().layer)),
    );

    it.effect(
      "[ports.project-namespaces-assign] places a project, found by id and by its name in any case, and assigning that place again succeeds",
      () =>
        Effect.gen(function* () {
          const projects = yield* ProjectNamespaces;
          const name = fresh("app");
          const asked = { projectId: projectId(), namespace: userId(), name: name.toUpperCase() };
          yield* projects.assign(asked);
          const place = { ...asked, name };
          expect(yield* projects.byId(asked.projectId)).toEqual(Option.some(place));
          expect(yield* projects.byName(asked.namespace, name)).toEqual(Option.some(place));
          expect(yield* projects.byName(asked.namespace, asked.name)).toEqual(Option.some(place));
          yield* projects.assign(asked);
          yield* projects.assign(place);
          expect(yield* projects.inNamespace(asked.namespace)).toEqual([place]);
        }).pipe(Effect.provide(make().layer)),
    );

    it.effect(
      "[ports.project-namespaces-release] gives a project's place back: the project has none, its name is free for another project of the namespace, and no other project's place moves; releasing again, or a project never placed, is a no-op",
      () =>
        Effect.gen(function* () {
          const projects = yield* ProjectNamespaces;
          const org = orgId();
          const name = fresh("app");
          const refused = { projectId: projectId(), namespace: org, name };
          const kept = { projectId: projectId(), namespace: org, name: fresh("kept") };
          yield* projects.assign(refused);
          yield* projects.assign(kept);

          yield* projects.release(refused.projectId);
          expect(Option.isNone(yield* projects.byId(refused.projectId))).toBe(true);
          expect(Option.isNone(yield* projects.byName(org, name))).toBe(true);
          expect(yield* projects.inNamespace(org)).toEqual([kept]);

          yield* projects.release(refused.projectId);
          yield* projects.release(projectId());
          const next = { projectId: projectId(), namespace: org, name };
          yield* projects.assign(next);
          expect(yield* projects.byName(org, name)).toEqual(Option.some(next));
          expect(yield* projects.byId(kept.projectId)).toEqual(Option.some(kept));
        }).pipe(Effect.provide(make().layer)),
    );

    it.effect(
      "[ports.project-namespaces-release-fresh] a released project placed again starts as any new one: private, and taking a visibility from the first seq, whatever its earlier row had mirrored",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const projects = yield* ProjectNamespaces;
          const org = { id: orgId(), slug: fresh("again") };
          yield* harness.seed({ orgs: [org] });
          const place = { projectId: projectId(), namespace: org.id, name: fresh("again") };
          const mirrored = Effect.map(
            projects.shownTo({ namespaces: [org.id] }, undefined, 10_000),
            (rows) => rows.find((row) => row.projectId === place.projectId)?.visibility,
          );
          yield* projects.assign(place);
          yield* projects.visibility(place.projectId, "public", 7);
          expect(yield* mirrored).toBe("public");

          yield* projects.release(place.projectId);
          expect(yield* mirrored).toBeUndefined();
          yield* projects.assign(place);
          expect(yield* mirrored).toBe("private");
          yield* projects.visibility(place.projectId, "public", 1);
          expect(yield* mirrored).toBe("public");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[ports.project-namespaces-taken] refuses a name the namespace holds, in any case, and another place for a placed project, with ProjectNameTaken",
      () =>
        Effect.gen(function* () {
          const projects = yield* ProjectNamespaces;
          const org = orgId();
          const elsewhere = userId();
          const name = fresh("app");
          const placed = { projectId: projectId(), namespace: org, name };
          yield* projects.assign(placed);
          const rival = projectId();
          expect(
            yield* Effect.flip(
              projects.assign({ projectId: rival, namespace: org, name: name.toUpperCase() }),
            ),
          ).toMatchObject({ _tag: "ProjectNameTaken", namespace: org, name });
          const renamed = fresh("renamed");
          expect(yield* Effect.flip(projects.assign({ ...placed, name: renamed }))).toMatchObject({
            _tag: "ProjectNameTaken",
            namespace: org,
            name: renamed,
          });
          expect(
            yield* Effect.flip(projects.assign({ ...placed, namespace: elsewhere })),
          ).toMatchObject({
            _tag: "ProjectNameTaken",
            namespace: elsewhere,
            name,
          });
          expect(yield* projects.byId(placed.projectId)).toEqual(Option.some(placed));
          expect(Option.isNone(yield* projects.byId(rival))).toBe(true);
          // The same name in another namespace, here a person's own, is another project's to take.
          yield* projects.assign({ projectId: rival, namespace: elsewhere, name });
          expect(yield* projects.byName(elsewhere, name)).toEqual(
            Option.some({ projectId: rival, namespace: elsewhere, name }),
          );
        }).pipe(Effect.provide(make().layer)),
    );

    it.effect(
      "[ports.project-namespaces-in-namespace] lists a namespace's projects by name, and only its own",
      () =>
        Effect.gen(function* () {
          const projects = yield* ProjectNamespaces;
          const org = orgId();
          const stem = fresh("p");
          const places = ["b", "c", "a"].map((suffix) => ({
            projectId: projectId(),
            namespace: org,
            name: `${stem}-${suffix}`,
          }));
          for (const place of places) yield* projects.assign(place);
          yield* projects.assign({ projectId: projectId(), namespace: orgId(), name: `${stem}-a` });
          expect((yield* projects.inNamespace(org)).map((place) => place.name)).toEqual(
            ["a", "b", "c"].map((suffix) => `${stem}-${suffix}`),
          );
        }).pipe(Effect.provide(make().layer)),
    );

    it.effect(
      "[ports.project-namespaces-shown] shows a visitor the public projects alone, an audience its namespaces' as well, and an agent's audience its one project, each row with its namespace",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const projects = yield* ProjectNamespaces;
          const ada = { id: userId(), username: fresh("ada") };
          const acme = { id: orgId(), slug: fresh("acme") };
          const globex = { id: orgId(), slug: fresh("globex") };
          yield* harness.seed({ users: [ada], orgs: [acme, globex] });
          const stem = fresh("shown");
          const place = (namespace: NamespaceId, i: number) => ({
            projectId: projectId(),
            namespace,
            name: `${stem}-${i}`,
          });
          const closed = place(acme.id, 0);
          const open = place(acme.id, 1);
          const own = place(ada.id, 2);
          const far = place(globex.id, 3);
          const all = [closed, open, own, far];
          for (const each of all) yield* projects.assign(each);
          yield* projects.visibility(open.projectId, "public", 1);
          const shown = (audience: ProjectAudience) =>
            Effect.map(projects.shownTo(audience, undefined, 10_000), (rows) =>
              rows.filter((row) => all.some((each) => each.projectId === row.projectId)),
            );

          const visitor = yield* shown({ namespaces: [] });
          expect(visitor).toEqual([
            { ...open, visibility: "public", handle: acme.slug, kind: "org", suspended: false },
          ]);
          expect(idsOf(yield* shown({ namespaces: [acme.id] }))).toEqual(ids(closed, open));
          const hers = yield* shown({ namespaces: [ada.id] });
          expect(idsOf(hers)).toEqual(ids(open, own));
          expect(hers.find((row) => row.projectId === own.projectId)).toEqual({
            ...own,
            visibility: "private",
            handle: ada.username,
            kind: "user",
            suspended: false,
          });
          expect(idsOf(yield* shown({ namespaces: [ada.id, globex.id] }))).toEqual(
            ids(open, own, far),
          );
          expect(idsOf(yield* shown({ namespaces: [], project: far.projectId }))).toEqual(
            ids(open, far),
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[ports.project-namespaces-shown-account] says of each row how its namespace stands, and leaves out a project whose namespace has no account",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const projects = yield* ProjectNamespaces;
          const banned = { id: userId(), username: fresh("banned"), banned: true };
          const held = { id: orgId(), slug: fresh("held"), suspended: true };
          yield* harness.seed({ users: [banned], orgs: [held] });
          const stem = fresh("account");
          const theirs = { projectId: projectId(), namespace: banned.id, name: `${stem}-0` };
          const helds = { projectId: projectId(), namespace: held.id, name: `${stem}-1` };
          const orphan = { projectId: projectId(), namespace: orgId(), name: `${stem}-2` };
          for (const each of [theirs, helds, orphan]) {
            yield* projects.assign(each);
            yield* projects.visibility(each.projectId, "public", 1);
          }
          const audience = { namespaces: [banned.id, held.id, orphan.namespace] };
          for (const rows of [
            yield* projects.shownTo({ namespaces: [] }, undefined, 10_000),
            yield* projects.shownTo(audience, undefined, 10_000),
          ]) {
            const suspended = (id: string) => rows.find((row) => row.projectId === id)?.suspended;
            expect(suspended(theirs.projectId)).toBe(true);
            expect(suspended(helds.projectId)).toBe(true);
            expect(rows.some((row) => row.projectId === orphan.projectId)).toBe(false);
          }
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[ports.project-namespaces-shown-pages] pages what an audience is shown by id, after a cursor and up to a limit",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const projects = yield* ProjectNamespaces;
          const org = { id: orgId(), slug: fresh("pages") };
          yield* harness.seed({ orgs: [org] });
          const stem = fresh("page");
          const places = [0, 1, 2].map((i) => ({
            projectId: projectId(),
            namespace: org.id,
            name: `${stem}-${i}`,
          }));
          for (const place of places) yield* projects.assign(place);
          const audience = { namespaces: [org.id] };
          const ours = (rows: readonly { readonly projectId: string }[]) =>
            rows
              .filter((row) => places.some((place) => place.projectId === row.projectId))
              .map((row) => row.projectId);
          const sorted = places.map((place) => place.projectId).toSorted();
          expect(ours(yield* projects.shownTo(audience, undefined, 10_000))).toEqual(sorted);
          const [one, two] = sorted;
          expect(ours(yield* projects.shownTo(audience, one, 10_000))).toEqual(sorted.slice(1));
          expect(yield* projects.shownTo(audience, undefined, 1)).toHaveLength(1);
          // A real adapter's table holds other cases' public projects, which every audience is shown too.
          const next = (yield* projects.shownTo(audience, one, 1)).map((row) => row.projectId);
          expect(next).toHaveLength(1);
          expect(next.every((id) => one !== undefined && id > one)).toBe(true);
          expect(next.every((id) => two !== undefined && id <= two)).toBe(true);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[ports.project-namespaces-visibility-seq] takes a visibility only from a seq above the one the row holds, and none for a project with no place",
      () => {
        const harness = make();
        return Effect.gen(function* () {
          const projects = yield* ProjectNamespaces;
          const org = { id: orgId(), slug: fresh("seq") };
          yield* harness.seed({ orgs: [org] });
          const place = { projectId: projectId(), namespace: org.id, name: fresh("seq") };
          const mirrored = Effect.map(
            projects.shownTo({ namespaces: [org.id] }, undefined, 10_000),
            (rows) => rows.find((row) => row.projectId === place.projectId)?.visibility,
          );
          yield* projects.visibility(place.projectId, "public", 5);
          yield* projects.assign(place);
          expect(yield* mirrored).toBe("private");

          yield* projects.visibility(place.projectId, "public", 2);
          expect(yield* mirrored).toBe("public");
          yield* projects.visibility(place.projectId, "private", 1);
          expect(yield* mirrored).toBe("public");
          yield* projects.visibility(place.projectId, "private", 2);
          expect(yield* mirrored).toBe("public");
          yield* projects.visibility(place.projectId, "private", 3);
          expect(yield* mirrored).toBe("private");
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
