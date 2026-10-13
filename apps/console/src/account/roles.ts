// The roles a member of an org holds on Keel, and what each is offered on an org's pages. Keel decides what a
// member may do, and refuses the rest: this keeps a page from offering what Keel would refuse, and no more.

import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

export const ROLES = ["owner", "maintainer", "member"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Keel's three roles, in Better Auth's terms. A maintainer may do everything but delete the org and make or
 * unmake an owner: the plugin's own `admin`, under Keel's name.
 */
export const ac = createAccessControl(defaultStatements);
export const roles = {
  owner: ac.newRole(ownerAc.statements),
  maintainer: ac.newRole(adminAc.statements),
  member: ac.newRole(memberAc.statements),
};

/** A role as Keel wrote it. One it does not name is read as the least. */
export function roleOf(given: string): Role {
  return ROLES.find((role) => role === given) ?? "member";
}

/** Whether a member of this role is offered the members' controls and the org's name to change. */
export function manages(role: Role): boolean {
  return role !== "member";
}

/** The roles a member of this role may give, or take away: only an owner makes or unmakes an owner. */
export function givable(role: Role): Role[] {
  if (role === "owner") return [...ROLES];
  return role === "maintainer" ? ["maintainer", "member"] : [];
}

/** Whether deleting an org is offered: to its owner, once they have typed its handle. */
export function mayDelete(org: { handle: string }, reader: { role: Role }, typed: string): boolean {
  return reader.role === "owner" && typed === org.handle;
}
