import { env } from "cloudflare:workers";
import { type BetterAuthRows, PORTS } from "@keeltown/testing";
import { Effect } from "effect";
import { MembershipsD1 } from "../../src/adapters/driven/d1/memberships.ts";
import { NamespacesD1 } from "../../src/adapters/driven/d1/namespaces.ts";
import { ProjectNamespacesD1 } from "../../src/adapters/driven/d1/project-namespaces.ts";
import { UsersD1 } from "../../src/adapters/driven/d1/users.ts";

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
PORTS.ProjectNamespaces.contract("d1", () => ProjectNamespacesD1(env.DB));
