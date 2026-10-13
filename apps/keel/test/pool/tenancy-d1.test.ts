import { env } from "cloudflare:workers";
import { makeId, type NamespaceId } from "@keeltown/core/kernel";
import { ProjectNamespaces } from "@keeltown/core/ports";
import { type BetterAuthRows, PORTS } from "@keeltown/testing";
import { Effect } from "effect";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import { MembershipsD1 } from "../../src/adapters/driven/d1/memberships.ts";
import { NamespacesD1 } from "../../src/adapters/driven/d1/namespaces.ts";
import { ProjectNamespacesD1 } from "../../src/adapters/driven/d1/project-namespaces.ts";
import { UsersD1 } from "../../src/adapters/driven/d1/users.ts";
import { recordingDb } from "./recording-db.ts";

/**
 * Writes Better Auth's rows by plain SQL, as its kysely adapter does on D1:
 * dates as ISO strings, flags as 0 or 1, users and orgs before their members.
 */
const seed = (rows: BetterAuthRows) =>
  Effect.promise(async () => {
    const at = new Date().toISOString();
    const statements = [
      ...(rows.users ?? []).map((user) =>
        env.DB.prepare(
          `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, username, banned, banExpires)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        ).bind(
          user.id,
          user.username ?? "someone",
          `${user.id.toLowerCase()}@users.keel.invalid`,
          at,
          at,
          user.username ?? null,
          user.banned === undefined ? null : Number(user.banned),
          user.banExpires?.toISOString() ?? null,
        ),
      ),
      ...(rows.orgs ?? []).map((org) =>
        env.DB.prepare(
          `INSERT INTO organization (id, name, slug, createdAt, suspended) VALUES (?, ?, ?, ?, ?)`,
        ).bind(org.id, org.slug, org.slug, at, Number(org.suspended === true)),
      ),
      ...(rows.members ?? []).map((member) =>
        env.DB.prepare(
          `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), member.organizationId, member.userId, member.role, at),
      ),
    ];
    if (statements.length > 0) await env.DB.batch(statements);
  });

// The tenancy ports on D1 pass the in-memory adapters' suites, over the tables migrations 0006 and 0008 make.
PORTS.Namespaces.contract("d1", () => ({ layer: NamespacesD1(env.DB), seed }));
PORTS.Users.contract("d1", () => ({ layer: UsersD1(env.DB), seed }));
PORTS.Memberships.contract("d1", () => ({ layer: MembershipsD1(env.DB), seed }));
PORTS.ProjectNamespaces.contract("d1", () => ({ layer: ProjectNamespacesD1(env.DB), seed }));

/** An org with `count` projects placed in it, each mirrored as `visibility`. */
const orgWith = (count: number, visibility: "private" | "public") =>
  Effect.gen(function* () {
    const org = { id: makeId("org", ulid()), slug: `d1-${ulid().toLowerCase()}` };
    yield* seed({ orgs: [org] });
    const places = yield* ProjectNamespaces;
    const projects = Array.from({ length: count }, () => makeId("prj", ulid()));
    for (const projectId of projects) {
      yield* places.assign({ projectId, namespace: org.id, name: projectId.toLowerCase() });
      yield* places.visibility(projectId, visibility, 1);
    }
    return { org, projects };
  }).pipe(Effect.provide(ProjectNamespacesD1(env.DB)));

/** The ids of the projects an audience is shown, read from D1. */
const shown = async (audience: { readonly namespaces: readonly NamespaceId[] }) =>
  (
    await Effect.runPromise(
      ProjectNamespaces.use((places) => places.shownTo(audience, undefined, 10_000)).pipe(
        Effect.provide(ProjectNamespacesD1(env.DB)),
      ),
    )
  ).map((row) => row.projectId);

describe("the list of projects on D1", () => {
  it("[d1.projects-shown-rows-read] a visitor's page reads the same rows however many private projects there are", async () => {
    const recording = recordingDb(env.DB);
    const visitor = ProjectNamespaces.use((places) =>
      places.shownTo({ namespaces: [] }, undefined, 10_000),
    ).pipe(Effect.provide(ProjectNamespacesD1(recording.db)));
    const cost = async () => {
      const rows = await Effect.runPromise(visitor);
      return { rows: rows.length, read: recording.reads.at(-1)?.rowsRead ?? 0 };
    };
    const open = await Effect.runPromise(orgWith(3, "public"));
    const before = await cost();
    expect(before.rows).toBeGreaterThanOrEqual(open.projects.length);
    expect(before.read).toBeGreaterThan(0);
    await Effect.runPromise(orgWith(40, "private"));
    expect(await cost()).toEqual(before);
    await Effect.runPromise(orgWith(1, "public"));
    expect((await cost()).read).toBeGreaterThan(before.read);
  });

  it("[d1.projects-shown-gone] a project whose org was deleted is left out, though the namespace's row stays", async () => {
    const { org, projects } = await Effect.runPromise(orgWith(1, "public"));
    expect(await shown({ namespaces: [] })).toEqual(expect.arrayContaining(projects));
    await env.DB.prepare("DELETE FROM organization WHERE id = ?").bind(org.id).run();
    const held = await env.DB.prepare("SELECT handle FROM namespaces WHERE id = ?")
      .bind(org.id)
      .first<{ handle: string }>();
    expect(held?.handle).toBe(org.slug);
    for (const audience of [{ namespaces: [] }, { namespaces: [org.id] }])
      for (const projectId of projects) expect(await shown(audience)).not.toContain(projectId);
  });
});
