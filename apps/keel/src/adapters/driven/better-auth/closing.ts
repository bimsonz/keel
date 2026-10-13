/**
 * What stands between a person and deleting their account, and what Better
 * Auth's own delete leaves behind. A person's projects and an org's last
 * owner are refused, each named, before anything changes: Keel deletes no
 * project yet, and an org always has an owner. The person's handle is not
 * touched here: its `namespaces` row stays, so it is never issued again.
 */
import type { NextAction } from "@keeltown/core/kernel";
import { APIError } from "better-auth/api";

/** The names of the projects in a person's own namespace, in order. */
export async function ownedProjects(db: D1Database, userId: string): Promise<readonly string[]> {
  const { results } = await db
    .prepare(`SELECT name FROM projects WHERE namespace_id = ?1 ORDER BY name`)
    .bind(userId)
    .all<{ name: string }>();
  return results.map((row) => row.name);
}

/** An org, as a refusal names it. */
export interface OrgNamed {
  readonly id: string;
  readonly slug: string;
}

/** Whether a member row's roles, as Better Auth joins them, hold `owner`. */
const owns = (roles: string | null): boolean =>
  (roles ?? "")
    .split(",")
    .map((role) => role.trim())
    .includes("owner");

/** The orgs a person is the one owner of, whoever else is a member, by name. */
export async function soleOwnerOf(db: D1Database, userId: string): Promise<readonly OrgNamed[]> {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.slug, m.role AS mine,
              (SELECT group_concat(x.role) FROM member x
                WHERE x.organizationId = m.organizationId AND x.userId != ?1) AS others
         FROM member m JOIN organization o ON o.id = m.organizationId
        WHERE m.userId = ?1 ORDER BY o.slug`,
    )
    .bind(userId)
    .all<{ id: string; slug: string; mine: string; others: string | null }>();
  return results
    .filter((row) => owns(row.mine) && !owns(row.others))
    .map((row) => ({ id: row.id, slug: row.slug }));
}

/** The refusal an account that owns projects is answered: Keel deletes no project yet, so it names the address that will. */
export const ownsProjects = (projects: readonly string[]): APIError =>
  new APIError("BAD_REQUEST", {
    code: "OWNS_PROJECTS",
    message: `Your account owns ${projects.length === 1 ? "a project" : "projects"} (${projects.join(", ")}), and an account that owns one is not deleted here: email privacy@keel.town and we'll delete it`,
    projects,
  });

/** The refusal an org's one owner is answered, with the way forward leaving an org gives. */
export const onlyOwner = (orgs: readonly OrgNamed[]): APIError =>
  new APIError("BAD_REQUEST", {
    code: "ONLY_OWNER",
    message: `An org always has an owner: make another member an owner of ${orgs.map((org) => org.slug).join(", ")} before you delete your account`,
    orgs,
    nextActions: orgs.map((org): NextAction => ({
      kind: "call",
      title: "Make another member an owner first",
      operationId: "ManageOwners",
      args: { organizationId: org.id },
    })),
  });

/** A deleted person, as the rows that outlive their account name them. */
export interface Gone {
  readonly id: string;
  readonly email: string;
  readonly handle: string | undefined;
}

/**
 * Deletes the rows that name a deleted person and that no foreign key
 * reaches: the device grants they approved, and the invitations addressed to
 * their handle or their address.
 */
export async function forget(db: D1Database, gone: Gone): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM deviceCode WHERE userId = ?1`).bind(gone.id),
    db
      .prepare(`DELETE FROM invitation WHERE handle = ?1 OR lower(email) = lower(?2)`)
      .bind(gone.handle ?? null, gone.email),
  ]);
}
