/**
 * Access levels on a repository, lowest first. Each level includes everything
 * below it: read < triage < write < maintain < admin.
 *
 * `owner` sits above the lattice. It is held by exactly one user, the
 * repository's owner, and it is never granted to a collaborator.
 */
export const COLLABORATOR_ROLES = ["read", "triage", "write", "maintain", "admin"] as const;

export type CollaboratorRole = (typeof COLLABORATOR_ROLES)[number];
export type Role = CollaboratorRole | "owner";

const RANK: Readonly<Record<Role, number>> = {
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
  owner: 6,
};

export function isCollaboratorRole(value: unknown): value is CollaboratorRole {
  return typeof value === "string" && (COLLABORATOR_ROLES as readonly string[]).includes(value);
}

/** True when `role` grants at least as much as `minimum`. */
export function atLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

/** Negative when `a` grants less than `b`, zero when equal, positive when more. */
export function compareRoles(a: Role, b: Role): number {
  return RANK[a] - RANK[b];
}
