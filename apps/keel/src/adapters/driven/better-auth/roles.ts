/**
 * Better Auth's org roles, derived from Keel's one policy (R11): a role holds
 * Better Auth's statements for an action exactly when `authorize` lets a member
 * with that role take the action, so a change to the rule is a change to
 * Better Auth's.
 */
import {
  type ACTIONS,
  type Action,
  authorize,
  type Role,
  type UserPrincipal,
} from "@keeltown/core/domain/identity";
import { makeId } from "@keeltown/core/kernel";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { Result } from "effect";

/** The actions decided on an org. */
export type OrgAction = {
  [A in Action]: (typeof ACTIONS)[A]["resource"] extends "Org" ? A : never;
}[Action];

type OrgStatements = {
  readonly [S in keyof typeof defaultStatements]?: readonly (typeof defaultStatements)[S][number][];
};

/**
 * Better Auth's statements, by the action they belong to: inviting, removing,
 * and moving a member between member and maintainer are ManageMembers; the
 * org's profile and its deletion are DeleteOrg. Making or unmaking an owner
 * (ManageOwners) has none: Better Auth's statements can't say which role a
 * change sets, so org.ts decides it before Better Auth sees the request.
 */
const ORG_STATEMENTS = {
  ManageMembers: { member: ["create", "update", "delete"], invitation: ["create", "cancel"] },
  DeleteOrg: { organization: ["update", "delete"] },
} as const satisfies Partial<Record<OrgAction, OrgStatements>>;

const SOME_ORG = makeId("org", "0".repeat(26));

/** Keel's policy on `action`, for a member of the org holding `role` there. */
export function decideAsRole(role: Role, action: OrgAction) {
  const member: UserPrincipal = {
    _tag: "User",
    userId: makeId("usr", "0".repeat(26)),
    handle: "member",
    instanceAdmin: false,
    suspended: false,
    memberships: [{ org: SOME_ORG, role }],
  };
  return authorize(member, action, { _tag: "Org", org: SOME_ORG, suspended: false });
}

const hasStatements = (action: string): action is keyof typeof ORG_STATEMENTS =>
  Object.hasOwn(ORG_STATEMENTS, action);
const STATEMENT_ACTIONS = Object.keys(ORG_STATEMENTS).filter(hasStatements);

/** The statements of every action Keel's policy lets `role` take. */
function statementsOf(role: Role): Record<string, string[]> {
  const holds: Record<string, string[]> = {};
  for (const action of STATEMENT_ACTIONS) {
    if (Result.isFailure(decideAsRole(role, action))) continue;
    for (const [resource, actions] of Object.entries(ORG_STATEMENTS[action]))
      holds[resource] = [...(holds[resource] ?? []), ...actions];
  }
  return holds;
}

export const orgAccess = createAccessControl(defaultStatements);
export const ORG_ROLES = {
  owner: orgAccess.newRole(statementsOf("owner")),
  maintainer: orgAccess.newRole(statementsOf("maintainer")),
  member: orgAccess.newRole(statementsOf("member")),
} satisfies Record<Role, unknown>;
