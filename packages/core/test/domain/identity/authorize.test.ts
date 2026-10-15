import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  type Action,
  type AgentPrincipal,
  type AgentResource,
  type AgentStanding,
  authorize,
  type AuthorizationRefusal,
  type ForkResource,
  type Grant,
  type Membership,
  type MemberStanding,
  type MissingResource,
  NON_SPEC_ACTIONS,
  type Need,
  type NamespaceResource,
  type Principal,
  type ProjectResource,
  type Resource,
  type ResourceKind,
  type Right,
  type Role,
  personOwns,
  rightsOf,
  type Scope,
  SPEC_ACTIONS,
  type UserPrincipal,
} from "../../../src/domain/identity/index.ts";
import {
  isId,
  makeId,
  namespaceKind,
  type NamespaceId,
  type OrgId,
  type ProjectId,
} from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";
import { assertReaching } from "../../support/reach.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const ORG_1 = makeId("org", ulid(1));
const ORG_2 = makeId("org", ulid(2));
const ORG_3 = makeId("org", ulid(3));
const ORGS = [ORG_1, ORG_2, ORG_3];
const USERS = [1, 2, 3].map((n) => makeId("usr", ulid(n)));
const PRJ_1 = makeId("prj", ulid(1));
const PRJ_2 = makeId("prj", ulid(2));
const PRJ_3 = makeId("prj", ulid(3));
const PRJ_4 = makeId("prj", ulid(4));
const PROJECTS = [PRJ_1, PRJ_2, PRJ_3, PRJ_4];
/** Each project's org: two in the first org, so an agent has a sibling project. */
const ORG_OF: ReadonlyMap<ProjectId, OrgId> = new Map([
  [PRJ_1, ORG_1],
  [PRJ_2, ORG_1],
  [PRJ_3, ORG_2],
  [PRJ_4, ORG_3],
]);
const orgOf = (p: ProjectId): OrgId => ORG_OF.get(p) ?? ORG_1;
/** A namespace of these suites as the org it is: every generated one is an org. */
const asOrg = (namespace: NamespaceId): OrgId => {
  if (!isId("org", namespace)) throw new Error(`not an org: ${namespace}`);
  return namespace;
};

const isAction = (name: string): name is Action => name in ACTIONS;
const ACTION_NAMES = Object.keys(ACTIONS).filter(isAction);
const needOf = (a: Action): Need => ACTIONS[a].need;
const kindOf = (a: Action): ResourceKind => ACTIONS[a].resource;
const ROLES: readonly Role[] = ["owner", "maintainer", "member"];
const RANK: Readonly<Record<Role, number>> = { member: 1, maintainer: 2, owner: 3 };

const rare = (oneIn: number): fc.Arbitrary<boolean> =>
  fc.integer({ min: 1, max: oneIn }).map((n) => n === 1);

const roleArb = fc.constantFrom(...ROLES);
const membershipsArb = fc
  .subarray(ORGS)
  .chain((orgs) => fc.tuple(...orgs.map((org) => roleArb.map((role) => ({ org, role })))));

const userArb: fc.Arbitrary<UserPrincipal> = fc
  .record({
    userId: fc.constantFrom(...USERS),
    handled: fc.integer({ min: 1, max: 8 }).map((n) => n !== 1),
    suspended: rare(8),
    memberships: membershipsArb,
  })
  .map(({ handled, ...u }) => ({ _tag: "User", ...u, ...(handled ? { handle: "ada" } : {}) }));

const scopesArb = fc.subarray<Scope>(["agent:work", "agent:read", "operator", "observer"]);
/** A member as an agent's inviter: one time in five it has left the org, one in eight it is suspended. */
const inviterArb: fc.Arbitrary<MemberStanding> = fc
  .record({
    userId: fc.constantFrom(...USERS),
    role: fc.oneof(
      { weight: 4, arbitrary: roleArb },
      { weight: 1, arbitrary: fc.constant(undefined) },
    ),
    suspended: rare(8),
  })
  .map(({ role, ...by }) => ({ ...by, ...(role === undefined ? {} : { role }) }));
const invitedArb: fc.Arbitrary<AgentStanding> = inviterArb.map((by) => ({ _tag: "Invited", by }));
const GOVERNS: AgentStanding = { _tag: "Governs" };
const NO_STANDING: AgentStanding = { _tag: "None" };
const standingArb: fc.Arbitrary<AgentStanding> = fc.oneof(
  { weight: 3, arbitrary: invitedArb },
  { weight: 2, arbitrary: fc.constant(GOVERNS) },
  { weight: 1, arbitrary: fc.constant(NO_STANDING) },
);
/** An agent whose token names a project, with that project's org. */
const placedAgentWith = (standing: fc.Arbitrary<AgentStanding>): fc.Arbitrary<AgentPrincipal> =>
  fc
    .record({
      projectId: fc.constantFrom(...PROJECTS),
      scopes: fc.oneof(fc.constant<Scope[]>(["agent:work", "agent:read"]), scopesArb),
      paused: rare(8),
      standing,
    })
    .map(({ projectId, ...a }) => ({
      _tag: "Agent",
      agentId: makeId("agt", ulid(1)),
      namespace: orgOf(projectId),
      projectId,
      ...a,
    }));
/** Any agent: one time in six its token names no project, only the namespace it stands in. */
const agentWith = (standing: fc.Arbitrary<AgentStanding>): fc.Arbitrary<AgentPrincipal> =>
  fc.oneof(
    { weight: 5, arbitrary: placedAgentWith(standing) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(placedAgentWith(standing), fc.constantFrom(...ORGS))
        .map(([{ projectId: _none, ...a }, org]) => ({ ...a, namespace: org })),
    },
  );
const agentArb = agentWith(standingArb);

const principalArb: fc.Arbitrary<Principal> = fc.oneof(
  { weight: 4, arbitrary: userArb },
  { weight: 4, arbitrary: agentArb },
  { weight: 1, arbitrary: fc.constant<Principal>({ _tag: "Anonymous" }) },
);

const projectArb: fc.Arbitrary<ProjectResource> = fc
  .record({
    projectId: fc.constantFrom(...PROJECTS),
    visibility: fc.constantFrom("private", "public"),
    namespaceSuspended: rare(6),
    personOwned: fc.boolean(),
    sponsor: fc.option(fc.constantFrom(...USERS), { nil: undefined }),
  })
  .map(({ sponsor, ...p }) => ({
    _tag: "Project",
    namespace: orgOf(p.projectId),
    ...p,
    ...(sponsor === undefined ? {} : { sponsor }),
  }));
const orgResArb: fc.Arbitrary<NamespaceResource> = fc.record({
  _tag: fc.constant("Namespace"),
  namespace: fc.constantFrom(...ORGS),
  suspended: rare(6),
  personOwned: fc.boolean(),
});
const MISSING: MissingResource = { _tag: "Missing" };
/** Every agent drawn as a principal is the first; the second is another agent's account. */
const BOT = makeId("agt", ulid(1));
const OTHER_BOT = makeId("agt", ulid(2));
/** An agent's account: the drawn agent's own or another's, with a known person behind it or nobody. */
const accountArb: fc.Arbitrary<AgentResource> = fc
  .record({
    agentId: fc.constantFrom(BOT, OTHER_BOT),
    sponsor: fc.option(fc.constantFrom(...USERS), { nil: undefined }),
  })
  .map(({ sponsor, ...a }) => ({
    _tag: "Agent",
    ...a,
    ...(sponsor === undefined ? {} : { sponsor }),
  }));
const forkArb: fc.Arbitrary<ForkResource> = fc.record({
  _tag: fc.constant("Fork"),
  source: fc.oneof(
    { weight: 6, arbitrary: projectArb },
    { weight: 1, arbitrary: fc.constant(MISSING) },
  ),
  target: orgResArb,
});

const resourceArb = (kind: ResourceKind): fc.Arbitrary<Resource> => {
  switch (kind) {
    case "Instance":
      return fc.constant({ _tag: "Instance" });
    case "Self":
      return fc.constant({ _tag: "Self" });
    case "Namespace":
    case "Org":
      return fc.oneof(
        { weight: 6, arbitrary: orgResArb },
        { weight: 1, arbitrary: fc.constant(MISSING) },
      );
    case "PersonalProject":
    case "Project":
      return fc.oneof(
        { weight: 6, arbitrary: projectArb },
        { weight: 1, arbitrary: fc.constant(MISSING) },
      );
    case "Agent":
      return fc.oneof(
        { weight: 6, arbitrary: accountArb },
        { weight: 1, arbitrary: fc.constant(MISSING) },
      );
    case "Fork":
      return forkArb;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
};

const actionArb = fc.constantFrom(...ACTION_NAMES);
const requestArb = actionArb.chain((action) =>
  fc.record({ action: fc.constant(action), resource: resourceArb(kindOf(action)) }),
);

/** `authorize` over any action, so over any resource; `requestArb` pairs each action with its kind. */
const decide = (principal: Principal, action: Action, resource: Resource) =>
  authorize<Action>(principal, action, resource);

/** A decision as one comparable string: `ok:<audience>`, `401`, `404` or `403:<reason>`. */
const outcome = (decision: Result.Result<Grant, AuthorizationRefusal>): string => {
  if (Result.isSuccess(decision)) return `ok:${decision.success.audience ?? ""}`;
  const e = decision.failure;
  switch (e._tag) {
    case "AuthenticationRequired":
      return "401";
    case "NotVisible":
      return "404";
    case "AccessRefused":
      return `403:${e.reason}`;
    default: {
      const unreachable: never = e;
      return unreachable;
    }
  }
};

/** Whether the principal is inside the org: a member, or an agent with a standing in it. */
const inside = (p: Principal, org: NamespaceId): boolean =>
  (p._tag === "User" && p.memberships.some((m) => m.org === org)) ||
  (p._tag === "Agent" && p.namespace === org && p.standing._tag !== "None");

const READS: ReadonlySet<Need> = new Set(["read", "readMembers", "readMembersOrSponsor"]);
const GOVERNING: ReadonlySet<Need> = new Set([
  "member",
  "invite",
  "maintain",
  "own",
  "ownAsUser",
  "sponsorOrMaintain",
  "sponsorOrMaintainAsUser",
  "inviterOrMaintain",
]);
/** The governing needs only a person meets, wherever an agent governs: an invitation names the person who answers for the agent. */
const PEOPLE_ONLY: ReadonlySet<Need> = new Set([
  "invite",
  "inviterOrMaintain",
  "sponsorOrMaintainAsUser",
]);
/** A person's own namespace that no drawn user or agent is in: its id is that person's. */
const SOMEONES: NamespaceId = makeId("usr", ulid(97));
const PEOPLES: readonly Right[] = ["member", "maintain", "own"];
const UNSCOPED: ReadonlySet<Need> = new Set([
  "anyone",
  "self",
  "agent",
  "account",
  "user",
  "handle",
]);

const user = (over: Partial<UserPrincipal> = {}): UserPrincipal => ({
  _tag: "User",
  userId: USERS[0] ?? makeId("usr", ulid(1)),
  handle: "ada",
  suspended: false,
  memberships: [],
  ...over,
});
const INVITER = USERS[1] ?? makeId("usr", ulid(2));
const invitedBy = (by: Partial<MemberStanding> = {}): AgentStanding => ({
  _tag: "Invited",
  by: { userId: INVITER, role: "member", suspended: false, ...by },
});
/** An invitation whose inviter has left the org: no role. */
const INVITER_LEFT: AgentStanding = { _tag: "Invited", by: { userId: INVITER, suspended: false } };
/** An agent with a token for `projectId`, invited there by a member unless `over` says otherwise. */
const agentOn = (projectId: ProjectId, over: Partial<AgentPrincipal> = {}): AgentPrincipal => ({
  _tag: "Agent",
  agentId: makeId("agt", ulid(1)),
  namespace: orgOf(projectId),
  projectId,
  scopes: ["agent:work", "agent:read"],
  paused: false,
  standing: invitedBy(),
  ...over,
});
/** An agent whose token names no project: it stands in `org` alone, invited unless `over` says otherwise. */
const agentIn = (org: NamespaceId, over: Partial<AgentPrincipal> = {}): AgentPrincipal => {
  const { projectId: _none, ...a } = agentOn(PRJ_1);
  return { ...a, namespace: org, ...over };
};
/** A project a person owns, unless `over` says otherwise. */
const project = (
  projectId: ProjectId,
  visibility: "private" | "public",
  over: Partial<ProjectResource> = {},
): ProjectResource => ({
  _tag: "Project",
  namespace: orgOf(projectId),
  projectId,
  visibility,
  namespaceSuspended: false,
  personOwned: true,
  ...over,
});
const ANON: Principal = { _tag: "Anonymous" };

/** The member who invited an agent, as a user: a member of the agent's org in its role, or of none once it left. */
const inviterOf = (a: AgentPrincipal, by: MemberStanding): UserPrincipal =>
  user({
    userId: by.userId,
    suspended: by.suspended,
    memberships: by.role === undefined ? [] : [{ org: asOrg(a.namespace), role: by.role }],
  });
/** An org a person owns, unless `over` says otherwise. */
const into = (org: NamespaceId, over: Partial<NamespaceResource> = {}): NamespaceResource => ({
  _tag: "Namespace",
  namespace: org,
  suspended: false,
  personOwned: true,
  ...over,
});

/** Whether the resource is the project the agent's token is for. */
const tokenProject = (a: AgentPrincipal, resource: Resource): boolean =>
  resource._tag === "Project" &&
  resource.projectId === a.projectId &&
  resource.namespace === a.namespace;

/** Whether the agent's standing counts now: it governs, or the member who invited it still answers for it. */
const standing = (a: AgentPrincipal): boolean =>
  !a.paused &&
  (a.standing._tag === "Governs" ||
    (a.standing._tag === "Invited" &&
      a.standing.by.role !== undefined &&
      !a.standing.by.suspended));

/** Whether the agent governs the resource: its token's project or the namespace it stands in, which no person owns. */
const governs = (a: AgentPrincipal, resource: Resource): boolean =>
  !a.paused &&
  a.standing._tag === "Governs" &&
  (tokenProject(a, resource) ||
    (resource._tag === "Namespace" && resource.namespace === a.namespace)) &&
  (resource._tag === "Project" || resource._tag === "Namespace") &&
  !resource.personOwned;

/** Whether the principal is a person who owns the resource's org: never an agent, wherever it governs. */
const owns = (principal: Principal, resource: ProjectResource | NamespaceResource): boolean =>
  principal._tag === "User" &&
  principal.memberships.some((m) => m.org === resource.namespace && m.role === "owner");

/**
 * Whether the principal is of the resource: a user with a membership in its
 * org (for a fork, the org it forks into); an agent on its token's project
 * while its standing counts; or an agent on the org it governs. Everyone else
 * is an outsider to it: an agent of the same org on another project, one whose
 * inviter left or is suspended, one with no standing, and one a person's org
 * was said to be governed by.
 */
const ofResource = (principal: Principal, resource: Resource): boolean => {
  switch (resource._tag) {
    case "Project":
      return principal._tag === "Agent"
        ? tokenProject(principal, resource) && standing(principal)
        : inside(principal, resource.namespace);
    case "Namespace":
      return principal._tag === "Agent"
        ? governs(principal, resource)
        : inside(principal, resource.namespace);
    case "Fork":
      return principal._tag === "User" && inside(principal, resource.target.namespace);
    default:
      return false;
  }
};

/**
 * The actions decided on something an org owns: a project, the org itself, or
 * a fork into it. An agent's own account is no org's.
 */
const OWNED_ACTIONS = ACTION_NAMES.filter(
  (a) => kindOf(a) !== "Instance" && kindOf(a) !== "Self" && kindOf(a) !== "Agent",
);
/** The actions decided on an agent's own account. */
const ACCOUNT_ACTIONS = ACTION_NAMES.filter((a) => kindOf(a) === "Agent");
/** The operations on a project's deploy targets, and those on a namespace's credentials. */
const TARGET_ACTIONS = [
  "Delivery_putDeployTarget",
  "Delivery_listDeployTargets",
  "Delivery_deleteDeployTarget",
] as const satisfies readonly Action[];
const CREDENTIAL_ACTIONS = [
  "Delivery_createCredential",
  "Delivery_listCredentials",
  "Delivery_deleteCredential",
] as const satisfies readonly Action[];

/**
 * The policy on an agent's account, said again apart from `authorize`: anyone
 * who may read reads it as the public; a move on it is its sponsor's, and the
 * link's end the agent's own too; to everyone else it is not there.
 */
const onAccount = (
  principal: Principal,
  need: Need,
  resource: AgentResource | MissingResource,
): string => {
  const there = resource._tag === "Agent";
  switch (principal._tag) {
    case "Anonymous":
      if (need !== "read") return "401";
      return there ? "ok:public" : "404";
    case "User":
      if (principal.suspended) return "403:user-suspended";
      if (principal.handle === undefined) return "403:handle-required";
      if (!there) return "404";
      if (need === "read") return "ok:public";
      return resource.sponsor === principal.userId ? "ok:" : "404";
    case "Agent":
      if (principal.paused) return "403:agent-paused";
      if (!there) return "404";
      if (need === "read")
        return principal.scopes.includes("agent:read") ? "ok:public" : "403:scope";
      if (resource.agentId !== principal.agentId) return "404";
      return need === "sponsorOrSelf" ? "ok:" : "403:users-only";
    default: {
      const unreachable: never = principal;
      return unreachable;
    }
  }
};
const ownedRequestArb = fc
  .constantFrom(...OWNED_ACTIONS)
  .chain((action) =>
    fc.record({ action: fc.constant(action), resource: resourceArb(kindOf(action)) }),
  );
/** Whether an action is decided on a namespace: any namespace's, or an org's own. */
const onNamespace = (a: Action): boolean => kindOf(a) === "Namespace" || kindOf(a) === "Org";
/**
 * Who holds `read` on an agent's account, written apart from `rightsOf`: a
 * visitor, a person in good standing with a handle, and an agent that is not
 * paused and may read.
 */
const readsAccounts = (p: Principal): boolean =>
  p._tag === "Anonymous" ||
  (p._tag === "User" && !p.suspended && p.handle !== undefined) ||
  (p._tag === "Agent" && !p.paused && p.scopes.includes("agent:read"));
/** The actions decided on a project or on a namespace. */
const actionsOn = (kind: "Project" | "Namespace"): readonly Action[] =>
  ACTION_NAMES.filter((a) => (kind === "Project" ? kindOf(a) === "Project" : onNamespace(a)));
const placedArb = fc.oneof(projectArb, orgResArb);

const subset = (rights: ReadonlySet<Right>, of: ReadonlySet<Right>): boolean =>
  [...rights].every((r) => of.has(r));
const READ_WORK: ReadonlySet<Right> = new Set(["read", "work"]);
/** Whether the resource's org is suspended. */
const shut = (resource: ProjectResource | NamespaceResource): boolean =>
  resource._tag === "Namespace" ? resource.suspended : resource.namespaceSuspended;
/**
 * What an action is decided on where the agent governs and no person owns: its
 * token's project, or the namespace itself. None when the action is a project's
 * and the token names no project.
 */
const governed = (
  agent: AgentPrincipal,
  action: Action,
  proj: ProjectResource,
  org: NamespaceResource,
): ProjectResource | NamespaceResource | undefined => {
  if (onNamespace(action))
    return { ...org, namespace: agent.namespace, suspended: false, personOwned: false };
  return agent.projectId === undefined
    ? undefined
    : {
        ...proj,
        projectId: agent.projectId,
        namespace: agent.namespace,
        namespaceSuspended: false,
        personOwned: false,
      };
};
/** The actions that ask for a governing right, on a project or an org. */
const GOVERNING_ACTIONS = [...actionsOn("Project"), ...actionsOn("Namespace")].filter((a) =>
  GOVERNING.has(needOf(a)),
);

/** What taking an agent out of an org answers the principal, on the org as its resolver gives it. */
const remove = (principal: Principal, resource: NamespaceResource) =>
  outcome(authorize(principal, "Namespaces_removeAgent", resource));

describe("authorize", () => {
  it("[authz.org-isolation] no principal reads a private project of an org it is not in", () => {
    fc.assert(
      fc.property(
        principalArb,
        projectArb,
        fc.constantFrom(...ACTION_NAMES.filter((a) => READS.has(needOf(a)))),
        (principal, resource, action) => {
          const p = { ...resource, visibility: "private" as const };
          return inside(principal, p.namespace) || Result.isFailure(decide(principal, action, p));
        },
      ),
    );
    const outsider = user({ memberships: [{ org: ORG_2, role: "owner" }] });
    expect(outcome(authorize(outsider, "Changes_listChanges", project(PRJ_1, "private")))).toBe(
      "404",
    );
    const member = user({ memberships: [{ org: ORG_1, role: "member" }] });
    expect(outcome(authorize(member, "Changes_listChanges", project(PRJ_1, "private")))).toBe(
      "ok:members",
    );
    const unplaced = agentOn(PRJ_1, { standing: NO_STANDING });
    expect(outcome(authorize(unplaced, "Changes_listChanges", project(PRJ_1, "private")))).toBe(
      "404",
    );
  });

  it("[authz.private-is-missing] an outsider cannot tell a private project from a missing one", () => {
    fc.assert(
      fc.property(
        principalArb,
        projectArb,
        fc.constantFrom(...ACTION_NAMES.filter((a) => kindOf(a) === "Project")),
        (principal, resource, action) => {
          const p = { ...resource, visibility: "private" as const };
          return (
            inside(principal, p.namespace) ||
            outcome(decide(principal, action, p)) === outcome(decide(principal, action, MISSING))
          );
        },
      ),
    );
    const outsider = user({ memberships: [{ org: ORG_2, role: "owner" }] });
    expect(outcome(authorize(outsider, "Operator_putSettings", project(PRJ_1, "private")))).toBe(
      "404",
    );
  });

  it("[authz.anonymous-public-only] anonymous reads public projects only, as the public", () => {
    fc.assert(
      fc.property(requestArb, ({ action, resource }) => {
        const result = outcome(decide(ANON, action, resource));
        const need = needOf(action);
        if (need === "anyone") return result === "ok:";
        if (need !== "read") return result === "401";
        return result === "ok:public" || result === "404";
      }),
    );
    fc.assert(
      fc.property(projectArb, (resource) => {
        const p = { ...resource, visibility: "public" as const, namespaceSuspended: false };
        return outcome(authorize(ANON, "Repo_getTree", p)) === "ok:public";
      }),
    );
    expect(outcome(authorize(ANON, "Repo_getTree", project(PRJ_1, "public")))).toBe("ok:public");
    expect(outcome(authorize(ANON, "Repo_getTree", project(PRJ_1, "private")))).toBe("404");
    expect(outcome(authorize(ANON, "declare", project(PRJ_1, "public")))).toBe("401");
  });

  it("[authz.inviter-or-maintain] any member invites an agent into an org; the member who invited it, a maintainer or an owner takes it out again, and no other member does", () => {
    const [ada, ben] = [USERS[0] ?? INVITER, INVITER];
    const as = (userId: typeof INVITER, role?: Role) =>
      user({ userId, memberships: role === undefined ? [] : [{ org: ORG_1, role }] });
    const invite = (principal: Principal, resource: NamespaceResource = into(ORG_1)) =>
      outcome(authorize(principal, "Namespaces_inviteAgent", resource));
    const invitedByBen = into(ORG_1, { inviter: ben });

    // Inviting is any member's, and nobody else's.
    expect(invite(as(ada, "member"))).toBe("ok:");
    expect(invite(as(ada, "maintainer"))).toBe("ok:");
    expect(invite(as(ada, "owner"))).toBe("ok:");
    expect(invite(as(ada))).toBe("403:role");
    expect(invite(user({ userId: ada, memberships: [{ org: ORG_2, role: "owner" }] }))).toBe(
      "403:role",
    );
    expect(invite(ANON)).toBe("401");

    // Taking an agent out: the member who invited it, whatever else they are; a maintainer; an owner.
    expect(remove(as(ben, "member"), invitedByBen)).toBe("ok:");
    expect(remove(as(ada, "member"), invitedByBen)).toBe("403:role");
    expect(remove(as(ada, "maintainer"), invitedByBen)).toBe("ok:");
    expect(remove(as(ada, "owner"), invitedByBen)).toBe("ok:");
    // The inviter who has left the org is no member: the invitation gives them nothing.
    expect(remove(as(ben), invitedByBen)).toBe("403:role");
    expect(remove(user({ userId: ben, suspended: true }), invitedByBen)).toBe("403:user-suspended");
    // With no invitation standing the resource names no inviter: only a maintainer is let through.
    expect(remove(as(ben, "member"), into(ORG_1))).toBe("403:role");
    expect(remove(as(ben, "maintainer"), into(ORG_1))).toBe("ok:");
    expect(remove(ANON, invitedByBen)).toBe("401");

    // An agent a member invited works there and never governs: it invites and removes no one, itself among them.
    const invited = agentIn(ORG_1, { standing: invitedBy({ userId: ben }) });
    expect(invite(invited)).toBe("403:users-only");
    expect(remove(invited, invitedByBen)).toBe("403:users-only");
    expect(invite(agentIn(ORG_1, { paused: true }))).toBe("403:agent-paused");

    // An agent is invited into an org: a person's own namespace and an agent's own take none.
    const own = into(ada, { inviter: ada });
    expect(invite(as(ada), into(ada))).toBe("404");
    expect(remove(as(ada), own)).toBe("404");
    const agentsOwn = makeId("agt", ulid(7));
    expect(invite(as(ada, "owner"), into(agentsOwn, { personOwned: false }))).toBe("404");
  });

  it("[authz.inviter-or-maintain] whatever role a person holds and whoever invited the agent, it is taken out by a maintainer, an owner or the member who invited it, and by nobody else", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...USERS),
        fc.option(roleArb, { nil: undefined }),
        fc.option(fc.constantFrom(...USERS), { nil: undefined }),
        (userId, role, inviter) => {
          const person = user({
            userId,
            memberships: role === undefined ? [] : [{ org: ORG_1, role }],
          });
          const org = into(ORG_1, inviter === undefined ? {} : { inviter });
          // Written apart from the policy: the role's rank, or a member's own invitation.
          const may =
            role !== undefined && (RANK[role] >= RANK.maintainer || inviter === person.userId);
          expect(remove(person, org)).toBe(may ? "ok:" : "403:role");
        },
      ),
    );
  });

  it("[authz.invite-people-only] no agent invites an agent or takes one out, even where it governs and no person owns: the invitation names the person who answers for it", () => {
    const unowned = into(ORG_1, { personOwned: false });
    const governor = agentIn(ORG_1, { standing: GOVERNS });
    // It does govern there: it makes a project, as an owner would.
    expect(outcome(authorize(governor, "Operator_createProject", unowned))).toBe("ok:");
    expect(outcome(authorize(governor, "Namespaces_inviteAgent", unowned))).toBe("403:users-only");
    expect(outcome(authorize(governor, "Namespaces_removeAgent", unowned))).toBe("403:users-only");
    expect(
      outcome(authorize(governor, "Namespaces_removeAgent", { ...unowned, inviter: INVITER })),
    ).toBe("403:users-only");
    // With a token for one of its projects, the same.
    const placed = agentOn(PRJ_1, { standing: GOVERNS });
    expect(outcome(authorize(placed, "Namespaces_inviteAgent", unowned))).toBe("403:users-only");
    expect(outcome(authorize(placed, "Namespaces_removeAgent", unowned))).toBe("403:users-only");
    // A person who is a member there still does, and a paused agent is told it is paused first.
    const member = user({ memberships: [{ org: ORG_1, role: "member" }] });
    expect(outcome(authorize(member, "Namespaces_inviteAgent", unowned))).toBe("ok:");
    expect(
      outcome(authorize({ ...governor, paused: true }, "Namespaces_inviteAgent", unowned)),
    ).toBe("403:agent-paused");
    // Every action that asks either need is asked of people alone.
    expect(ACTION_NAMES.filter((a) => PEOPLE_ONLY.has(needOf(a))).toSorted()).toEqual([
      "Namespaces_inviteAgent",
      "Namespaces_removeAgent",
      "Operator_giveRuling",
    ]);
  });

  it("[authz.personal-project] a person invites an agent to a project of their own namespace and takes it off again; of a project anywhere else the action is asked of nothing, and no agent does either", () => {
    const [ada, ben] = [USERS[0] ?? INVITER, INVITER];
    const hers = project(PRJ_1, "private", { namespace: ada });
    const invite = (principal: Principal, resource: ProjectResource = hers) =>
      outcome(authorize(principal, "Projects_inviteAgent", resource));
    const takeOff = (principal: Principal, resource: ProjectResource = hers) =>
      outcome(authorize(principal, "Projects_removeAgent", resource));

    // Her own project: hers to invite to and to take an agent off, with no membership anywhere.
    expect(invite(user({ userId: ada }))).toBe("ok:");
    expect(takeOff(user({ userId: ada }))).toBe("ok:");
    // Anyone else: her private project is not there, and her public one gives them no role.
    expect(invite(user({ userId: ben }))).toBe("404");
    expect(takeOff(user({ userId: ben }))).toBe("404");
    const shown = { ...hers, visibility: "public" as const };
    expect(invite(user({ userId: ben }), shown)).toBe("403:role");
    expect(takeOff(user({ userId: ben }), shown)).toBe("403:role");
    expect(invite(ANON)).toBe("401");
    expect(invite(user({ userId: ada, suspended: true }))).toBe("403:user-suspended");

    // An org's project takes no such invitation, whoever asks: an org takes an agent whole.
    const orgs = project(PRJ_1, "private");
    const owner = user({ userId: ada, memberships: [{ org: ORG_1, role: "owner" }] });
    expect(outcome(authorize(owner, "Operator_putSettings", orgs))).toBe("ok:");
    expect(invite(owner, orgs)).toBe("404");
    expect(takeOff(owner, orgs)).toBe("404");
    expect(invite(owner, { ...orgs, visibility: "public" })).toBe("404");
    // Nor does a project of an agent's own namespace.
    const agentsOwn = makeId("agt", ulid(7));
    const its = project(PRJ_1, "public", { namespace: agentsOwn, personOwned: false });
    expect(invite(owner, its)).toBe("404");
    expect(invite(agentOn(PRJ_1, { namespace: agentsOwn, standing: GOVERNS }), its)).toBe("404");

    // An agent she invited to it works there and never governs: it invites no one and takes no one off.
    const invited = agentOn(PRJ_1, {
      namespace: ada,
      standing: invitedBy({ userId: ada, role: "owner" }),
    });
    expect(outcome(authorize(invited, "declare", hers))).toBe("ok:");
    expect(invite(invited)).toBe("403:users-only");
    expect(takeOff(invited)).toBe("403:users-only");
    // Invited to that one project, the rest of her namespace is to it what it is to anyone:
    // her other private project is not there, where an agent an org took in is told it is another's.
    const toOne = agentOn(PRJ_1, {
      namespace: ada,
      standing: {
        _tag: "Invited",
        by: { userId: ada, role: "owner", suspended: false },
        projectOnly: true,
      },
    });
    const sibling = project(PRJ_2, "private", { namespace: ada });
    expect(outcome(authorize(toOne, "declare", hers))).toBe("ok:");
    expect(outcome(authorize(toOne, "Views_getTrunk", hers))).toBe("ok:members");
    expect(outcome(authorize(toOne, "Views_getTrunk", sibling))).toBe("404");
    expect(outcome(authorize(toOne, "Namespaces_getProject", sibling))).toBe("404");
    expect(rightsOf(toOne, sibling).size).toBe(0);
    expect(outcome(authorize(toOne, "Views_getTrunk", { ...sibling, visibility: "public" }))).toBe(
      "ok:public",
    );
    expect(outcome(authorize(invited, "Views_getTrunk", sibling))).toBe("403:foreign-project");
    // Her namespace suspended: on its project it is told so, and of the rest it is told nothing.
    expect(outcome(authorize(toOne, "declare", { ...hers, namespaceSuspended: true }))).toBe(
      "403:org-suspended",
    );
    expect(
      outcome(authorize(toOne, "Views_getTrunk", { ...sibling, namespaceSuspended: true })),
    ).toBe("404");
    // Its inviter no longer answering for it, it is told why on its project, and still nothing of the rest.
    const orphaned = agentOn(PRJ_1, {
      namespace: ada,
      standing: {
        _tag: "Invited",
        by: { userId: ada, suspended: true, role: "owner" },
        projectOnly: true,
      },
    });
    expect(outcome(authorize(orphaned, "declare", hers))).toBe("403:inviter-suspended");
    expect(outcome(authorize(orphaned, "Views_getTrunk", sibling))).toBe("404");

    // Anyone who reads the project reads its agents: the policy says as whom.
    expect(outcome(authorize(user({ userId: ada }), "Projects_listAgents", hers))).toBe(
      "ok:members",
    );
    expect(outcome(authorize(ANON, "Projects_listAgents", shown))).toBe("ok:public");
    expect(outcome(authorize(ANON, "Projects_listAgents", hers))).toBe("404");

    // Typed apart from the table: the rows asked of a person's own project alone.
    expect(ACTION_NAMES.filter((a) => kindOf(a) === "PersonalProject").toSorted()).toEqual([
      "Projects_inviteAgent",
      "Projects_removeAgent",
    ]);
  });

  it("[authz.agent-invited-read-work] an invited agent reads and works on its token's project while its inviter answers for it, and never holds more than that member", () => {
    fc.assert(
      fc.property(
        agentWith(invitedArb),
        fc.oneof(projectArb, orgResArb, fc.constant(MISSING)),
        (agent, resource) => {
          if (agent.standing._tag !== "Invited") return false;
          const { by } = agent.standing;
          const answers = by.role !== undefined && !by.suspended;
          const rights = rightsOf(agent, resource);
          // Never more than the member who invited it; once that member left or is suspended, never more than the public.
          const bound = rightsOf(answers ? inviterOf(agent, by) : ANON, resource);
          const placed = tokenProject(agent, resource);
          const whole =
            placed &&
            answers &&
            !agent.paused &&
            resource._tag === "Project" &&
            !resource.namespaceSuspended;
          return (
            subset(rights, READ_WORK) &&
            [...rights].every((r) => bound.has(r === "work" ? "member" : r)) &&
            (placed || subset(rights, rightsOf(ANON, resource))) &&
            (!rights.has("read") || agent.scopes.includes("agent:read")) &&
            (!rights.has("work") || agent.scopes.includes("agent:work")) &&
            (!whole ||
              (rights.has("read") === agent.scopes.includes("agent:read") &&
                rights.has("work") === agent.scopes.includes("agent:work")))
          );
        },
      ),
    );
    // On its token's project: what it is granted, and what it is told once its inviter no longer answers for it.
    fc.assert(
      fc.property(
        placedAgentWith(invitedArb),
        projectArb,
        fc.constantFrom(...actionsOn("Project")),
        (a, p, action) => {
          if (a.standing._tag !== "Invited" || a.projectId === undefined) return false;
          const { by } = a.standing;
          const agent = { ...a, paused: false };
          const resource = {
            ...p,
            projectId: a.projectId,
            namespace: a.namespace,
            namespaceSuspended: false,
          };
          const result = outcome(decide(agent, action, resource));
          const need = needOf(action);
          const reads = a.scopes.includes("agent:read");
          if (GOVERNING.has(need)) return result === "403:users-only";
          if (by.role !== undefined && !by.suspended) {
            if (READS.has(need)) return result === (reads ? "ok:members" : "403:scope");
            return result === (a.scopes.includes("agent:work") ? "ok:" : "403:scope");
          }
          if (need === "read" && resource.visibility === "public")
            return result === (reads ? "ok:public" : "403:scope");
          return result === (by.suspended ? "403:inviter-suspended" : "403:inviter-left");
        },
      ),
    );
    const left = agentOn(PRJ_1, { standing: INVITER_LEFT });
    expect(outcome(authorize(left, "declare", project(PRJ_1, "public")))).toBe("403:inviter-left");
    expect(outcome(authorize(left, "Repo_getTree", project(PRJ_1, "public")))).toBe("ok:public");
    expect(outcome(authorize(left, "Repo_getTree", project(PRJ_1, "private")))).toBe(
      "403:inviter-left",
    );
    expect([...rightsOf(left, project(PRJ_1, "private"))]).toEqual([]);
    const banned = agentOn(PRJ_1, { standing: invitedBy({ role: "owner", suspended: true }) });
    expect(outcome(authorize(banned, "declare", project(PRJ_1, "private")))).toBe(
      "403:inviter-suspended",
    );
    expect(outcome(authorize(banned, "whoami", { _tag: "Self" }))).toBe("ok:");
    const byOwner = agentOn(PRJ_1, { standing: invitedBy({ role: "owner" }) });
    expect([...rightsOf(byOwner, project(PRJ_1, "private"))].toSorted()).toEqual(["read", "work"]);
    expect(outcome(authorize(byOwner, "Operator_putSettings", project(PRJ_1, "private")))).toBe(
      "403:users-only",
    );
    expect(outcome(authorize(byOwner, "Operator_enrolAgent", project(PRJ_1, "private")))).toBe(
      "403:users-only",
    );
    expect([...rightsOf(byOwner, into(ORG_1))]).toEqual(["read"]);
    // A token that names no project: invited into the org, it works nowhere until a token names one.
    const nowhere = agentIn(ORG_1);
    expect([...rightsOf(nowhere, project(PRJ_1, "private"))]).toEqual([]);
    expect(outcome(authorize(nowhere, "declare", project(PRJ_1, "public")))).toBe(
      "403:foreign-project",
    );
    expect(outcome(authorize(nowhere, "Repo_getTree", project(PRJ_1, "public")))).toBe("ok:public");
    expect([
      ...rightsOf(agentOn(PRJ_1), project(PRJ_1, "private", { namespaceSuspended: true })),
    ]).toEqual([]);
  });

  it("[authz.agent-own-project] an agent reads its token's project as a member while its standing counts, any other as the public", () => {
    fc.assert(
      fc.property(
        agentArb,
        projectArb,
        fc.constantFrom(
          ...ACTION_NAMES.filter((a) => needOf(a) === "read" && kindOf(a) === "Project"),
        ),
        (agent, resource, action) => {
          const stands = tokenProject(agent, resource) && standing(agent);
          const result = outcome(decide(agent, action, resource));
          return result === "ok:members" ? stands : !stands || !result.startsWith("ok:");
        },
      ),
    );
    expect(outcome(authorize(agentOn(PRJ_1), "Views_getTrunk", project(PRJ_1, "private")))).toBe(
      "ok:members",
    );
    expect(outcome(authorize(agentOn(PRJ_1), "Views_getTrunk", project(PRJ_2, "public")))).toBe(
      "ok:public",
    );
    expect(outcome(authorize(agentOn(PRJ_1), "Views_getTrunk", project(PRJ_2, "private")))).toBe(
      "403:foreign-project",
    );
    expect(outcome(authorize(agentOn(PRJ_1), "Views_getTrunk", project(PRJ_3, "private")))).toBe(
      "404",
    );
    expect(outcome(authorize(agentOn(PRJ_1), "declare", project(PRJ_1, "private")))).toBe("ok:");
    const unplaced = agentOn(PRJ_1, { standing: NO_STANDING });
    expect(outcome(authorize(unplaced, "Views_getTrunk", project(PRJ_1, "public")))).toBe(
      "ok:public",
    );
    expect(outcome(authorize(unplaced, "declare", project(PRJ_1, "public")))).toBe(
      "403:foreign-project",
    );
  });

  it("[authz.agent-paused] a paused agent has no rights and is refused everything but whoami and its inbox, told that it is paused", () => {
    const readsWhilePaused = new Set(["whoami", "inbox"]);
    fc.assert(
      fc.property(agentArb, requestArb, (a, { action, resource }) => {
        const paused = { ...a, paused: true };
        const result = decide(paused, action, resource);
        if (readsWhilePaused.has(action))
          return rightsOf(paused, resource).size === 0 && outcome(result) !== "403:agent-paused";
        return (
          rightsOf(paused, resource).size === 0 &&
          outcome(result) === "403:agent-paused" &&
          Result.isFailure(result) &&
          "nextActions" in result.failure &&
          result.failure.nextActions.length > 0
        );
      }),
    );
    const mine = project(PRJ_1, "public", { personOwned: false });
    const paused = agentOn(PRJ_1, { paused: true, standing: GOVERNS });
    expect(outcome(authorize(paused, "Lattices_listLattices", { _tag: "Instance" }))).toBe(
      "403:agent-paused",
    );
    expect(outcome(authorize(paused, "whoami", { _tag: "Self" }))).toBe("ok:");
    expect(outcome(authorize(paused, "inbox", { _tag: "Self" }))).toBe("ok:");
    expect(outcome(authorize(paused, "askSponsor", { _tag: "Self" }))).toBe("403:agent-paused");
    expect(outcome(authorize(paused, "Agents_listReachableProjects", { _tag: "Self" }))).toBe(
      "403:agent-paused",
    );
    expect(outcome(authorize(paused, "Repo_getTree", project(PRJ_3, "public")))).toBe(
      "403:agent-paused",
    );
    expect(outcome(authorize(paused, "declare", mine))).toBe("403:agent-paused");
    expect([...rightsOf(paused, mine)]).toEqual([]);
    expect(outcome(authorize({ ...paused, paused: false }, "declare", mine))).toBe("ok:");
  });

  it("[authz.agent-never-governs-a-person] no agent governs what a person owns, whatever its standing says", () => {
    fc.assert(
      fc.property(
        agentArb,
        projectArb,
        orgResArb,
        fc.constantFrom(...GOVERNING_ACTIONS),
        (agent, proj, org, action) => {
          const owned = [
            { ...proj, personOwned: true },
            { ...org, personOwned: true },
          ];
          const rules = owned.some((r) => PEOPLES.some((right) => rightsOf(agent, r).has(right)));
          const resource =
            kindOf(action) === "Project"
              ? { ...proj, personOwned: true }
              : { ...org, personOwned: true };
          return !rules && Result.isFailure(decide(agent, action, resource));
        },
      ),
    );
    // Said to govern, on the very project its token is for and on that project's org: still nothing of a person's.
    fc.assert(
      fc.property(
        placedAgentWith(fc.constant(GOVERNS)),
        fc.constantFrom<"private" | "public">("private", "public"),
        fc.constantFrom(...GOVERNING_ACTIONS),
        (a, visibility, action) => {
          if (a.projectId === undefined) return false;
          const agent = { ...a, paused: false };
          const mine = project(a.projectId, visibility);
          const namespace = into(agent.namespace);
          const resource = kindOf(action) === "Project" ? mine : namespace;
          return (
            subset(rightsOf(agent, mine), READ_WORK) &&
            subset(rightsOf(agent, namespace), READ_WORK) &&
            outcome(decide(agent, action, resource)) === "403:users-only"
          );
        },
      ),
    );
    const governor = agentOn(PRJ_1, { standing: GOVERNS });
    const persons: Readonly<Record<ResourceKind, Resource>> = {
      Instance: { _tag: "Instance" },
      Self: { _tag: "Self" },
      Project: project(PRJ_1, "private"),
      // A person's own project that anyone may read: an agent sees it, and still governs nothing on it.
      PersonalProject: project(PRJ_1, "public", { namespace: SOMEONES }),
      Namespace: into(ORG_1),
      Org: into(ORG_1),
      Agent: { _tag: "Agent", agentId: BOT },
      Fork: { _tag: "Fork", source: project(PRJ_1, "private"), target: into(ORG_1) },
    };
    const taken = OWNED_ACTIONS.filter((a) => GOVERNING.has(needOf(a))).flatMap((action) => {
      const result = outcome(decide(governor, action, persons[kindOf(action)]));
      return result === "403:users-only" ? [] : [`${action}: ${result}`];
    });
    expect(taken).toEqual([]);
    expect(OWNED_ACTIONS.filter((a) => GOVERNING.has(needOf(a))).length).toBeGreaterThan(10);
    // It keeps its read and its work there.
    expect([...rightsOf(governor, project(PRJ_1, "private"))].toSorted()).toEqual(["read", "work"]);
    expect(outcome(authorize(governor, "declare", project(PRJ_1, "private")))).toBe("ok:");
    expect(outcome(authorize(governor, "Views_getTrunk", project(PRJ_1, "private")))).toBe(
      "ok:members",
    );
    expect(outcome(authorize(governor, "Operator_listProjects", into(ORG_1)))).toBe("ok:public");
    expect(outcome(authorize(governor, "DeleteOrg", into(ORG_1)))).toBe("403:users-only");
    expect(outcome(authorize(governor, "ManageOwners", into(ORG_1)))).toBe("403:users-only");
    const projectless = agentIn(ORG_1, { standing: GOVERNS });
    expect(outcome(authorize(projectless, "Operator_createProject", into(ORG_1)))).toBe(
      "403:users-only",
    );
  });

  it("[authz.agent-governs-its-own] where it governs and no person owns, an agent is granted its own work and whatever an owner is but the namespace's credentials and the project's deploy targets, on its token's project and the namespace itself", () => {
    fc.assert(
      fc.property(
        agentWith(fc.constant(GOVERNS)),
        projectArb,
        orgResArb,
        fc.constantFrom(...actionsOn("Project"), ...actionsOn("Namespace")),
        (a, proj, org, action) => {
          const agent = { ...a, paused: false };
          const resource = governed(agent, action, proj, org);
          if (resource === undefined) {
            // Its token names no project: every project of its namespace is the public's to it.
            const any = {
              ...proj,
              namespace: agent.namespace,
              namespaceSuspended: false,
              personOwned: false,
            };
            const result = outcome(decide(agent, action, any));
            return (
              subset(rightsOf(agent, any), rightsOf(ANON, any)) &&
              (!result.startsWith("ok:") || (result === "ok:public" && needOf(action) === "read"))
            );
          }
          const owner = user({ memberships: [{ org: asOrg(agent.namespace), role: "owner" }] });
          const theirs = outcome(decide(owner, action, resource));
          const its = outcome(decide(agent, action, resource));
          const need = needOf(action);
          // Its scopes cap its reading and its work, and nothing else.
          if (need === "work")
            return its === (agent.scopes.includes("agent:work") ? "ok:" : "403:scope");
          if (READS.has(need))
            return its === (agent.scopes.includes("agent:read") ? theirs : "403:scope");
          // Inviting an agent, and taking one out, are a person's even here: the record names who answers for it.
          if (PEOPLE_ONLY.has(need)) return theirs === "ok:" && its === "403:users-only";
          // So are a namespace's credentials and a project's deploy targets: no agent holds them, wherever it governs.
          if (need === "ownAsUser") return theirs === "ok:" && its === "403:users-only";
          return theirs === "ok:" && its === "ok:";
        },
      ),
    );
    // Only there: its token's project and the namespace itself, never a sibling project or another org.
    fc.assert(
      fc.property(agentWith(fc.constant(GOVERNS)), placedArb, (a, resource) => {
        const agent = { ...a, paused: false };
        const rights = rightsOf(agent, resource);
        const there =
          tokenProject(agent, resource) ||
          (resource._tag === "Namespace" && resource.namespace === agent.namespace);
        const rules = there && !resource.personOwned && !shut(resource);
        return (
          PEOPLES.every((r) => rights.has(r) === rules) &&
          (!rights.has("work") || tokenProject(agent, resource))
        );
      }),
    );
    const unscoped = agentOn(PRJ_1, { standing: GOVERNS, scopes: [] });
    const mine = project(PRJ_1, "private", { personOwned: false });
    const namespace = into(ORG_1, { personOwned: false });
    expect(outcome(authorize(unscoped, "DeleteProject", mine))).toBe("ok:");
    expect(outcome(authorize(unscoped, "Operator_putSettings", mine))).toBe("ok:");
    expect(outcome(authorize(unscoped, "DeleteOrg", namespace))).toBe("ok:");
    expect(outcome(authorize(unscoped, "ManageOwners", namespace))).toBe("ok:");
    expect(outcome(authorize(unscoped, "Operator_createProject", namespace))).toBe("ok:");
    expect(outcome(authorize(unscoped, "declare", mine))).toBe("403:scope");
    const governor = agentOn(PRJ_1, { standing: GOVERNS });
    expect(outcome(authorize(governor, "declare", mine))).toBe("ok:");
    expect(outcome(authorize(governor, "Operator_getSettings", mine))).toBe("ok:members");
    expect(outcome(authorize(governor, "Operator_listProjects", namespace))).toBe("ok:members");
    // A sibling project of the namespace it governs: its token is for another project.
    const sibling = project(PRJ_2, "private", { personOwned: false });
    expect(outcome(authorize(governor, "Operator_putSettings", sibling))).toBe(
      "403:foreign-project",
    );
    expect(outcome(authorize(governor, "Views_getTrunk", sibling))).toBe("403:foreign-project");
    expect(outcome(authorize(governor, "DeleteOrg", into(ORG_2, { personOwned: false })))).toBe(
      "403:users-only",
    );
    // A new agent's first token names no project: in its own namespace it makes its first one.
    const fresh = agentIn(ORG_1, { standing: GOVERNS, scopes: [] });
    expect(outcome(authorize(fresh, "Operator_createProject", namespace))).toBe("ok:");
    expect(outcome(authorize(fresh, "DeleteOrg", namespace))).toBe("ok:");
    expect(outcome(authorize(fresh, "Operator_putSettings", mine))).toBe("403:foreign-project");
    expect(outcome(authorize(fresh, "Operator_createProject", into(ORG_2)))).toBe("403:users-only");
    expect([...rightsOf(agentIn(ORG_1, { standing: GOVERNS }), mine)]).toEqual([]);
  });

  it("[authz.any-account] any account makes an org, a person with a handle or an agent, and only a person takes a handle", () => {
    fc.assert(
      fc.property(principalArb, (principal) => {
        const made = outcome(decide(principal, "CreateOrg", { _tag: "Instance" }));
        const named = outcome(decide(principal, "SetHandle", { _tag: "Self" }));
        if (principal._tag === "Anonymous") return made === "401" && named === "401";
        if (principal._tag === "Agent")
          return principal.paused
            ? made === "403:agent-paused" && named === "403:agent-paused"
            : made === "ok:" && named === "403:users-only";
        if (principal.suspended)
          return made === "403:user-suspended" && named === "403:user-suspended";
        return (
          named === "ok:" &&
          made === (principal.handle === undefined ? "403:handle-required" : "ok:")
        );
      }),
    );
    const bare = agentOn(PRJ_1, { standing: NO_STANDING, scopes: [] });
    expect(outcome(authorize(bare, "CreateOrg", { _tag: "Instance" }))).toBe("ok:");
    expect(outcome(authorize(bare, "SetHandle", { _tag: "Self" }))).toBe("403:users-only");
    expect(outcome(authorize(bare, "Users_me", { _tag: "Self" }))).toBe("403:users-only");
    expect(outcome(authorize(user(), "CreateOrg", { _tag: "Instance" }))).toBe("ok:");
  });

  it("[authz.role-ladder] a role grants what every role below it grants", () => {
    const NEEDED: Partial<Record<Need, number>> = {
      member: 1,
      readMembers: 1,
      readMembersOrSponsor: 1,
      maintain: 2,
      workOrMaintain: 2,
      invite: 1,
      sponsorOrMaintain: 2,
      sponsorOrMaintainAsUser: 2,
      inviterOrMaintain: 2,
      own: 3,
      ownAsUser: 3,
    };
    fc.assert(
      fc.property(
        roleArb,
        fc.oneof(projectArb, orgResArb),
        fc.constantFrom(
          ...ACTION_NAMES.filter(
            (a) => NEEDED[needOf(a)] !== undefined && (kindOf(a) === "Project" || onNamespace(a)),
          ),
        ),
        (role, resource, action) => {
          const r =
            resource._tag === "Project"
              ? {
                  ...resource,
                  namespaceSuspended: false,
                  sponsor: USERS[2] ?? makeId("usr", ulid(3)),
                }
              : { ...resource, suspended: false };
          if (kindOf(action) !== r._tag) return true;
          const u = user({ memberships: [{ org: asOrg(r.namespace), role }] });
          const granted = outcome(decide(u, action, r)).startsWith("ok:");
          return granted === RANK[role] >= (NEEDED[needOf(action)] ?? 0);
        },
      ),
    );
    const owner = user({ memberships: [{ org: ORG_1, role: "owner" }] });
    expect(outcome(authorize(owner, "Operator_putSettings", project(PRJ_1, "private")))).toBe(
      "ok:",
    );
    const sponsor = user({ memberships: [{ org: ORG_1, role: "member" }] });
    expect(
      outcome(
        authorize(
          sponsor,
          "Operator_giveRuling",
          project(PRJ_1, "private", { sponsor: sponsor.userId }),
        ),
      ),
    ).toBe("ok:");
  });

  it("[authz.ruling-people-only] a ruling is a person's: a maintainer or the sponsor rules, and an agent that maintains the project is refused", () => {
    const governing = agentOn(PRJ_1, { standing: GOVERNS });
    const resource = project(PRJ_1, "private", { personOwned: false });
    expect(outcome(authorize(governing, "Operator_putSettings", resource))).toBe("ok:");
    expect(outcome(authorize(governing, "Operator_giveRuling", resource))).toBe("403:users-only");
    const maintainer = user({ memberships: [{ org: ORG_1, role: "maintainer" }] });
    expect(outcome(authorize(maintainer, "Operator_giveRuling", resource))).toBe("ok:");
  });

  it("[authz.member-management] a maintainer manages members but not owners, and only an owner deletes the org", () => {
    fc.assert(
      fc.property(roleArb, orgResArb, (role, resource) => {
        const org = { ...resource, suspended: false };
        const u = user({ memberships: [{ org: asOrg(org.namespace), role }] });
        const may = (action: Action) => outcome(decide(u, action, org)) === "ok:";
        return (
          may("ManageMembers") === (role !== "member") &&
          may("ManageOwners") === (role === "owner") &&
          may("DeleteOrg") === (role === "owner")
        );
      }),
    );
    const maintainer = user({ memberships: [{ org: ORG_1, role: "maintainer" }] });
    expect(outcome(authorize(maintainer, "ManageMembers", into(ORG_1)))).toBe("ok:");
    expect(outcome(authorize(maintainer, "ManageOwners", into(ORG_1)))).toBe("403:role");
  });

  it("[authz.deploy-owner-only] only an owner of the org, and a person, sets a project's deploy targets or touches the org's credentials; never an agent, wherever it governs", () => {
    fc.assert(
      fc.property(principalArb, projectArb, orgResArb, (principal, proj, org) => {
        const targets = TARGET_ACTIONS.some((action) =>
          outcome(decide(principal, action, proj)).startsWith("ok:"),
        );
        const credentials = CREDENTIAL_ACTIONS.some((action) =>
          outcome(decide(principal, action, org)).startsWith("ok:"),
        );
        return (!targets || owns(principal, proj)) && (!credentials || owns(principal, org));
      }),
    );
    const owner = user({ memberships: [{ org: ORG_1, role: "owner" }] });
    const maintainer = user({ memberships: [{ org: ORG_1, role: "maintainer" }] });
    const mine = project(PRJ_1, "private");
    const governor = agentOn(PRJ_1, { standing: GOVERNS });
    for (const action of TARGET_ACTIONS) {
      expect([action, outcome(authorize(owner, action, mine))]).toEqual([action, "ok:"]);
      expect([action, outcome(authorize(maintainer, action, mine))]).toEqual([action, "403:role"]);
      expect([action, outcome(authorize(governor, action, mine))]).toEqual([
        action,
        "403:users-only",
      ]);
    }
    for (const action of CREDENTIAL_ACTIONS) {
      expect([action, outcome(authorize(owner, action, into(ORG_1)))]).toEqual([action, "ok:"]);
      expect([action, outcome(authorize(maintainer, action, into(ORG_1)))]).toEqual([
        action,
        "403:role",
      ]);
      expect(outcome(authorize(owner, action, into(ORG_2)))).not.toBe("ok:");
      expect([action, outcome(authorize(governor, action, into(ORG_1)))]).toEqual([
        action,
        "403:users-only",
      ]);
      expect([
        action,
        outcome(authorize(governor, action, into(ORG_1, { personOwned: false }))),
      ]).toEqual([action, "403:users-only"]);
    }
  });

  it("[authz.sync-own] a sync from upstream is its project's owners' alone, decided as the project's deletion is", () => {
    fc.assert(
      fc.property(principalArb, projectArb, (principal, resource) => {
        return (
          outcome(decide(principal, "Operator_syncUpstream", resource)) ===
          outcome(decide(principal, "DeleteProject", resource))
        );
      }),
    );
    const inOrg = (role: (typeof ROLES)[number]) => user({ memberships: [{ org: ORG_1, role }] });
    const theirs = project(PRJ_1, "private");
    expect(
      ROLES.map((role) => outcome(authorize(inOrg(role), "Operator_syncUpstream", theirs))),
    ).toEqual(ROLES.map((role) => (role === "owner" ? "ok:" : "403:role")));
  });

  it("[authz.handle-first] a user without a handle may only choose one", () => {
    fc.assert(
      fc.property(userArb, requestArb, (u, { action, resource }) => {
        const { handle: _none, ...rest } = u;
        const result = outcome(decide({ ...rest, suspended: false }, action, resource));
        return action === "SetHandle" ? result === "ok:" : result === "403:handle-required";
      }),
    );
    const { handle: _none, ...nameless } = user({ memberships: [{ org: ORG_1, role: "owner" }] });
    expect(outcome(authorize(nameless, "Repo_getTree", project(PRJ_1, "public")))).toBe(
      "403:handle-required",
    );
  });

  it("[authz.no-instance-role] nothing is decided on the instance but signing in or up, the lattices and making an org", () => {
    const onInstance = Object.entries(ACTIONS)
      .filter(([, rule]) => rule.resource === "Instance")
      .map(([action, rule]) => `${action}: ${rule.need}`)
      .toSorted();
    expect(onInstance).toEqual([
      "Auth_exchangeToken: anyone",
      "Auth_registerClient: anyone",
      "CreateOrg: account",
      "Lattices_listLattices: anyone",
      "SignIn_methods: anyone",
    ]);
  });

  it("[authz.outsider-public-only] whoever is not of a project or an org is granted a public read of it, and nothing more", () => {
    fc.assert(
      fc.property(principalArb, ownedRequestArb, (principal, { action, resource }) => {
        const result = outcome(decide(principal, action, resource));
        if (!result.startsWith("ok:")) return true;
        return (
          ofResource(principal, resource) || (result === "ok:public" && needOf(action) === "read")
        );
      }),
    );
    const outsider = user({ memberships: [{ org: ORG_2, role: "owner" }] });
    const open = project(PRJ_1, "public");
    expect(outcome(authorize(outsider, "Repo_getTree", open))).toBe("ok:public");
    expect(outcome(authorize(outsider, "Operator_enrolAgent", open))).toBe("403:role");
    expect(outcome(authorize(outsider, "Operator_putSettings", open))).toBe("403:role");
    expect(outcome(authorize(outsider, "Operator_listProjects", into(ORG_1)))).toBe("ok:public");
    expect(outcome(authorize(agentOn(PRJ_1), "Operator_listProjects", into(ORG_1)))).toBe(
      "ok:public",
    );
    expect(outcome(authorize(agentOn(PRJ_1), "Repo_getTree", project(PRJ_2, "public")))).toBe(
      "ok:public",
    );
    expect(outcome(authorize(outsider, "Repo_getTree", MISSING))).toBe("404");
    // The whole table, row by row: a generated run meets any one action too rarely to be relied on.
    const strangers: readonly (readonly [string, Principal])[] = [
      ["another org's owner", outsider],
      ["nobody", ANON],
      ["another org's agent", agentOn(PRJ_3)],
      ["a sibling project's agent", agentOn(PRJ_2)],
      ["an agent that governs another org", agentOn(PRJ_3, { standing: GOVERNS })],
      ["its own agent, with no standing", agentOn(PRJ_1, { standing: NO_STANDING })],
      ["its own agent, whose inviter left", agentOn(PRJ_1, { standing: INVITER_LEFT })],
      [
        "its own agent, whose inviter is suspended",
        agentOn(PRJ_1, { standing: invitedBy({ suspended: true }) }),
      ],
      ["its own agent, paused", agentOn(PRJ_1, { standing: GOVERNS, paused: true })],
      ["an agent invited into the org, whose token names no project", agentIn(ORG_1)],
    ];
    /** Agents said to govern the namespace on a token for another project or for none: of the org itself only when no person owns it. */
    const governors: readonly (readonly [string, Principal])[] = [
      [
        "an agent that governs the namespace, on a sibling project",
        agentOn(PRJ_2, { standing: GOVERNS }),
      ],
      [
        "an agent that governs the namespace, on a token that names no project",
        agentIn(ORG_1, { standing: GOVERNS }),
      ],
    ];
    const more = [true, false].flatMap((personOwned) => {
      const theirs: Readonly<Record<ResourceKind, Resource>> = {
        Instance: { _tag: "Instance" },
        Self: { _tag: "Self" },
        Project: project(PRJ_1, "public", { personOwned }),
        PersonalProject: project(PRJ_1, "public", { namespace: SOMEONES }),
        Namespace: into(ORG_1, { personOwned }),
        Org: into(ORG_1, { personOwned }),
        Agent: { _tag: "Agent", agentId: BOT },
        Fork: {
          _tag: "Fork",
          source: project(PRJ_1, "public", { personOwned }),
          target: into(ORG_1, { personOwned }),
        },
      };
      return OWNED_ACTIONS.flatMap((action) => {
        const kind = kindOf(action);
        const who = personOwned || !onNamespace(action) ? [...strangers, ...governors] : strangers;
        return who.flatMap(([name, principal]) => {
          const result = outcome(decide(principal, action, theirs[kind]));
          const publicRead = result === "ok:public" && needOf(action) === "read";
          return result.startsWith("ok:") && !publicRead ? [`${action} by ${name}: ${result}`] : [];
        });
      });
    });
    expect(more).toEqual([]);
    expect(OWNED_ACTIONS.length).toBeGreaterThan(40);
  });

  it("[authz.suspended] a suspended user or org is refused, and an org's insiders are told why", () => {
    fc.assert(
      fc.property(userArb, requestArb, (u, { action, resource }) => {
        const result = outcome(decide({ ...u, suspended: true }, action, resource));
        return result === "403:user-suspended";
      }),
    );
    fc.assert(
      fc.property(
        fc.oneof(userArb, agentArb),
        fc.oneof(projectArb, orgResArb),
        actionArb,
        (p, resource, action) => {
          const r =
            resource._tag === "Project"
              ? { ...resource, namespaceSuspended: true }
              : { ...resource, suspended: true };
          if (kindOf(action) !== r._tag) return true;
          const principal =
            p._tag === "User" ? { ...p, suspended: false, handle: "ada" } : { ...p, paused: false };
          const need = needOf(action);
          const result = outcome(decide(principal, action, r));
          const scoped = !UNSCOPED.has(need) && (principal._tag === "Agent" || need !== "work");
          if (!scoped) return !result.startsWith("403:org-suspended") && result !== "404";
          return result === (inside(principal, r.namespace) ? "403:org-suspended" : "404");
        },
      ),
    );
    const member = agentOn(PRJ_1);
    expect(
      outcome(
        authorize(member, "declare", project(PRJ_1, "private", { namespaceSuspended: true })),
      ),
    ).toBe("403:org-suspended");
    expect(
      outcome(
        authorize(
          agentOn(PRJ_1, { standing: NO_STANDING }),
          "declare",
          project(PRJ_1, "public", { namespaceSuspended: true }),
        ),
      ),
    ).toBe("404");
    expect(outcome(authorize(user({ suspended: true }), "whoami", { _tag: "Self" }))).toBe(
      "403:user-suspended",
    );
  });

  it("[authz.agent-resource] an agent's account is read by anyone as the public; only its sponsor pauses it, only its sponsor or the agent itself ends the link, and to everyone else such a move is not there", () => {
    fc.assert(
      fc.property(
        principalArb,
        fc.constantFrom(...ACCOUNT_ACTIONS),
        resourceArb("Agent"),
        (principal, action, resource) => {
          if (resource._tag !== "Agent" && resource._tag !== "Missing") return false;
          const rights = [...rightsOf(principal, resource)].join();
          return (
            outcome(decide(principal, action, resource)) ===
              onAccount(principal, needOf(action), resource) &&
            rights === (resource._tag === "Agent" && readsAccounts(principal) ? "read" : "")
          );
        },
      ),
    );
    expect(ACCOUNT_ACTIONS.map((a) => `${a}: ${needOf(a)}`).toSorted()).toEqual([
      "Agents_endSponsorship: sponsorOrSelf",
      "Agents_getAgent: read",
      "Operator_reinstateAgent: sponsor",
      "Operator_suspendAgent: sponsor",
    ]);
    const [ann, , cy] = USERS;
    if (ann === undefined || cy === undefined) throw new Error("three users are drawn from");
    const account: AgentResource = { _tag: "Agent", agentId: BOT, sponsor: ann };
    const sponsor = user({ userId: ann });
    // An owner of the org the agent works in, who does not sponsor it.
    const owner = user({ userId: cy, memberships: [{ org: ORG_1, role: "owner" }] });
    const itself = agentOn(PRJ_1);
    const another = agentOn(PRJ_1, { agentId: OTHER_BOT });
    const moves = ["Operator_suspendAgent", "Operator_reinstateAgent", "Agents_endSponsorship"];
    const read = (who: Principal, on: AgentResource | MissingResource = account) =>
      moves.filter(isAction).map((move) => outcome(decide(who, move, on)));
    expect(read(sponsor)).toEqual(["ok:", "ok:", "ok:"]);
    // Whoever does not sponsor it cannot tell it from an agent that does not exist.
    expect(read(owner)).toEqual(["404", "404", "404"]);
    expect(read(owner, MISSING)).toEqual(["404", "404", "404"]);
    expect(read(sponsor, MISSING)).toEqual(["404", "404", "404"]);
    // The agent leaves its sponsor; only a person pauses.
    expect(read(itself)).toEqual(["403:users-only", "403:users-only", "ok:"]);
    expect(read(another)).toEqual(["404", "404", "404"]);
    // Paused, it is refused before anything else, so it cannot leave the sponsor who paused it.
    expect(read({ ...itself, paused: true })).toEqual([
      "403:agent-paused",
      "403:agent-paused",
      "403:agent-paused",
    ]);
    expect(read(ANON)).toEqual(["401", "401", "401"]);
    expect(read(user({ userId: ann, suspended: true }))).toEqual([
      "403:user-suspended",
      "403:user-suspended",
      "403:user-suspended",
    ]);
    // With nobody behind it, nobody pauses it.
    const alone: AgentResource = { _tag: "Agent", agentId: BOT };
    expect(read(sponsor, alone)).toEqual(["404", "404", "404"]);
    expect(read(itself, alone)).toEqual(["403:users-only", "403:users-only", "ok:"]);
    // Anyone reads who the agent is, and as the public: its sponsor too.
    const card = (who: Principal, on: AgentResource | MissingResource = account) =>
      outcome(authorize(who, "Agents_getAgent", on));
    expect([ANON, owner, sponsor, itself, another].map((who) => card(who))).toEqual([
      "ok:public",
      "ok:public",
      "ok:public",
      "ok:public",
      "ok:public",
    ]);
    expect([ANON, owner, sponsor, itself].map((who) => card(who, MISSING))).toEqual([
      "404",
      "404",
      "404",
      "404",
    ]);
    expect(card(agentOn(PRJ_1, { scopes: ["agent:work"] }))).toBe("403:scope");
    expect(card({ ...itself, paused: true })).toBe("403:agent-paused");
  });

  it("[authz.spec-covered] every operation in the spec is decided by the policy, and only those are spec actions", () => {
    const spec = readFileSync(
      join(import.meta.dirname, "../../../../contracts/openapi.json"),
      "utf8",
    );
    const operationIds = [...spec.matchAll(/"operationId":\s*"([^"]+)"/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    expect(operationIds.length).toBeGreaterThan(40);
    expect(Object.keys(SPEC_ACTIONS).toSorted()).toEqual(operationIds.toSorted());
    expect(Object.keys(NON_SPEC_ACTIONS).filter((a) => operationIds.includes(a))).toEqual([]);
  });

  it("[authz.unauthenticated-next] whoever has no credential is told to sign up, an operation anyone may call, and then to read the walk at /start, which is no operation", () => {
    let unauthenticated = 0;
    assertReaching(
      fc.property(requestArb, ({ action, resource }) => {
        const result = decide(ANON, action, resource);
        if (Result.isSuccess(result) || result.failure._tag !== "AuthenticationRequired")
          return true;
        unauthenticated += 1;
        const [signUp, read, ...more] = result.failure.nextActions;
        return (
          more.length === 0 &&
          signUp?.kind === "call" &&
          signUp.operationId === "Auth_registerClient" &&
          // An offer to someone with no credential is one they can take with none.
          isAction(signUp.operationId) &&
          outcome(decide(ANON, signUp.operationId, { _tag: "Instance" })) === "ok:" &&
          read?.kind === "read" &&
          read.operationId === undefined &&
          read.title.includes("/start")
        );
      }),
    );
    expect(unauthenticated).toBeGreaterThan(0);
  });

  it("[authz.refusal-shape] every 401 and 403 names a next action; a 404 says nothing", () => {
    fc.assert(
      fc.property(principalArb, requestArb, (principal, { action, resource }) => {
        const result = decide(principal, action, resource);
        if (Result.isSuccess(result)) return true;
        const e = result.failure;
        if (e._tag === "NotVisible") return Object.keys(e).every((k) => k === "_tag");
        return e.nextActions.length > 0;
      }),
    );
    const member = user({ memberships: [{ org: ORG_1, role: "member" }] });
    const refusal = authorize(member, "Operator_putSettings", project(PRJ_1, "private"));
    expect(
      Result.isFailure(refusal) &&
        refusal.failure._tag === "AccessRefused" &&
        refusal.failure.reason,
    ).toBe("role");
    expect(
      Result.isFailure(refusal) &&
        "nextActions" in refusal.failure &&
        refusal.failure.nextActions.length,
    ).toBe(1);
  });

  it("[authz.fork] a user forks what it reads into an org it is in, and a private project only within its org", () => {
    fc.assert(
      fc.property(userArb, forkArb, (u, resource) => {
        const result = outcome(authorize(u, "Operator_forkProject", resource));
        if (u.suspended || u.handle === undefined) return !result.startsWith("ok:");
        const { source, target } = resource;
        const readable =
          source._tag === "Project" &&
          !source.namespaceSuspended &&
          (source.visibility === "public" || inside(u, source.namespace));
        if (!readable)
          return source._tag === "Project" &&
            source.namespaceSuspended &&
            inside(u, source.namespace)
            ? result === "403:org-suspended"
            : result === "404";
        const granted =
          !target.suspended &&
          inside(u, target.namespace) &&
          (source.visibility === "public" || source.namespace === target.namespace);
        return granted === (result === "ok:");
      }),
    );
    const member = user({
      memberships: [
        { org: ORG_1, role: "member" },
        { org: ORG_2, role: "owner" },
      ],
    });
    expect(
      outcome(
        authorize(member, "Operator_forkProject", {
          _tag: "Fork",
          source: project(PRJ_1, "private"),
          target: into(ORG_2),
        }),
      ),
    ).toBe("403:private-source");
    expect(
      outcome(
        authorize(member, "Operator_forkProject", {
          _tag: "Fork",
          source: project(PRJ_1, "private"),
          target: into(ORG_1),
        }),
      ),
    ).toBe("ok:");
    expect(
      outcome(
        authorize(user(), "Operator_forkProject", {
          _tag: "Fork",
          source: project(PRJ_1, "private"),
          target: into(ORG_2),
        }),
      ),
    ).toBe("404");
  });
});

describe("authorize: the rows a sponsor's link is made by", () => {
  it("[authz.sponsor-rows] any account asks for a sponsor, and only a person approves a link or lists the agents behind them", () => {
    // Typed apart from the table. The handlers check no caller's kind: these rows are all that does.
    const LINK_ROWS = [
      "Agents_approveSponsor: Self user",
      "Agents_listSponsored: Self user",
      "askSponsor: Self self",
    ];
    const rows = ["Agents_approveSponsor", "Agents_listSponsored", "askSponsor"].filter(isAction);
    expect(rows.map((a) => `${a}: ${kindOf(a)} ${needOf(a)}`)).toEqual(LINK_ROWS);
    const answers = (who: Principal): string =>
      rows.map((a) => outcome(decide(who, a, { _tag: "Self" }))).join(" ");
    fc.assert(
      fc.property(
        agentArb,
        (agent) => answers({ ...agent, paused: false }) === "403:users-only 403:users-only ok:",
      ),
    );
    expect(answers(user())).toBe("ok: ok: ok:");
    expect(answers(ANON)).toBe("401 401 401");
    expect(answers(agentOn(PRJ_1, { paused: true }))).toBe(
      "403:agent-paused 403:agent-paused 403:agent-paused",
    );
  });
});

describe("authorize: the rows an invitation is made, read and answered by", () => {
  // Typed apart from the table. A person who invites and an agent who answers are told apart here, in the policy.
  const INVITATION_ROWS = [
    "Namespaces_inviteAgent: Org invite",
    "Namespaces_removeAgent: Org inviterOrMaintain",
    "Namespaces_listAgents: Namespace read",
    "Projects_inviteAgent: PersonalProject own",
    "Projects_removeAgent: PersonalProject own",
    "Projects_listAgents: Project read",
    "Agents_listNamespaces: Self agent",
    "Agents_acceptInvitation: Self agent",
    "Agents_leaveNamespace: Self agent",
    "Agents_listProjects: Self agent",
    "Agents_acceptProjectInvitation: Self agent",
    "Agents_leaveProject: Self agent",
    "Agents_listReachableProjects: Self agent",
    "Agents_useProject: Self agent",
  ];
  const rows = INVITATION_ROWS.map((row) => row.slice(0, row.indexOf(":"))).filter(isAction);
  const itsOwn = rows.filter((a) => kindOf(a) === "Self");
  const all = (answer: string): string => itsOwn.map(() => answer).join(" ");
  const answers = (who: Principal): string =>
    itsOwn.map((a) => outcome(decide(who, a, { _tag: "Self" }))).join(" ");

  it("[authz.invitation-rows] an invitation is made and ended by people and read, accepted and left by the agent it names: a person is refused the agent's rows, and an agent the org's two", () => {
    expect(rows.map((a) => `${a}: ${kindOf(a)} ${needOf(a)}`)).toEqual(INVITATION_ROWS);
    expect(itsOwn).toHaveLength(8);
    // These eight (the six an invitation is read, accepted and left by, what the accepted ones reach, and the run's choice among them) are every row that asks for an agent; what a person reads of themselves asks `self`, and the two a paused agent still reads ask `selfRead`.
    expect(ACTION_NAMES.filter((a) => needOf(a) === "agent").toSorted()).toEqual(itsOwn.toSorted());
    expect(ACTION_NAMES.filter((a) => needOf(a) === "self").toSorted()).toEqual(["askSponsor"]);
    expect(ACTION_NAMES.filter((a) => needOf(a) === "selfRead").toSorted()).toEqual([
      "inbox",
      "whoami",
    ]);

    // The agent's own seven: any agent that is not paused, and no person, whoever they are.
    fc.assert(
      fc.property(agentArb, (agent) => answers({ ...agent, paused: false }) === all("ok:")),
    );
    fc.assert(
      fc.property(
        userArb,
        (person) =>
          answers({ ...person, suspended: false, handle: "ada" }) === all("403:agents-only"),
      ),
    );
    fc.assert(fc.property(userArb, (person) => !answers(person).includes("ok:")));
    expect(answers(user())).toBe(all("403:agents-only"));
    expect(answers(user({ memberships: [{ org: ORG_1, role: "owner" }] }))).toBe(
      all("403:agents-only"),
    );
    expect(answers(ANON)).toBe(all("401"));
    expect(answers(agentOn(PRJ_1, { paused: true }))).toBe(all("403:agent-paused"));

    // The org's two: no agent is granted either, whatever its standing and whoever invited the one it names.
    fc.assert(
      fc.property(
        agentArb,
        orgResArb,
        fc.option(fc.constantFrom(...USERS), { nil: undefined }),
        (agent, org, inviter) => {
          const asked = { ...org, ...(inviter === undefined ? {} : { inviter }) };
          const said = [
            decide({ ...agent, paused: false }, "Namespaces_inviteAgent", asked),
            decide({ ...agent, paused: false }, "Namespaces_removeAgent", asked),
          ].map(outcome);
          expect(said.filter((answer) => answer.startsWith("ok:"))).toEqual([]);
        },
      ),
    );
    const governor = agentIn(ORG_1, { standing: GOVERNS });
    const unowned = into(ORG_1, { personOwned: false, inviter: INVITER });
    expect(
      [
        decide(governor, "Namespaces_inviteAgent", unowned),
        decide(governor, "Namespaces_removeAgent", unowned),
        decide(ANON, "Namespaces_inviteAgent", unowned),
        decide(ANON, "Namespaces_removeAgent", unowned),
      ].map(outcome),
    ).toEqual(["403:users-only", "403:users-only", "401", "401"]);
  });
});

/** A membership that names any namespace as its org: the lie a gate could tell, since a membership's `org` is an org's id. */
const lyingMembership = (namespace: NamespaceId, role: Role): Membership =>
  JSON.parse(JSON.stringify({ org: namespace, role }));
const idOf = (principal: UserPrincipal | AgentPrincipal): string =>
  principal._tag === "User" ? principal.userId : principal.agentId;
const nobodyToAsk = (whose: string): string =>
  `This is ${whose} namespace and has no members: only its owner does this. Use your own namespace, or an org you are a member of`;

/** A person with a handle, whose memberships may name the namespace itself, as only a gate that lied would fill them. */
const personAt = (namespace: NamespaceId): fc.Arbitrary<UserPrincipal> =>
  fc.tuple(userArb, fc.option(roleArb, { nil: undefined })).map(([drawn, role]) => ({
    ...drawn,
    handle: "ada",
    suspended: false,
    memberships:
      role === undefined
        ? drawn.memberships
        : [...drawn.memberships, lyingMembership(namespace, role)],
  }));

describe("authorize: a namespace by its kind", () => {
  const ADA = USERS[0] ?? makeId("usr", ulid(1));
  const BEA = USERS[2] ?? makeId("usr", ulid(3));
  const ada = user({ userId: ADA });
  const bea = user({ userId: BEA });
  /** Ada's own namespace: its id is hers, and it has no members. */
  const own = (over: Partial<NamespaceResource> = {}): NamespaceResource => into(ADA, over);
  const hers = project(PRJ_1, "private", { namespace: ADA });
  /** An agent's own namespace: its id is the agent's, and no person owns it. */
  const bots = into(BOT, { personOwned: false });

  /** The accounts with a namespace of their own: three people and two agents. */
  const ACCOUNTS: readonly NamespaceId[] = [...USERS, BOT, OTHER_BOT];
  /** Someone's own namespace. `personOwned` is drawn, not derived: the rules hold whatever the gate filled. */
  const ownArb: fc.Arbitrary<NamespaceResource> = fc.record({
    _tag: fc.constant("Namespace"),
    namespace: fc.constantFrom(...ACCOUNTS),
    suspended: fc.constant(false),
    personOwned: fc.boolean(),
  });
  /** An agent of any standing whose token is for the namespace, and for one of its projects or none. */
  const agentAt = (namespace: NamespaceId): fc.Arbitrary<AgentPrincipal> =>
    fc
      .tuple(agentArb, fc.constantFrom(BOT, OTHER_BOT))
      .map(([drawn, agentId]) => ({ ...drawn, agentId, namespace, paused: false }));
  /** Someone's own namespace or a project in it, with someone who asks there. */
  const askedArb = ownArb.chain((namespace) =>
    fc.record({
      namespace: fc.constant(namespace),
      resource: fc.oneof(
        fc.constant<ProjectResource | NamespaceResource>(namespace),
        fc.record({
          _tag: fc.constant("Project"),
          namespace: fc.constant(namespace.namespace),
          projectId: fc.constantFrom(...PROJECTS),
          visibility: fc.constantFrom("private", "public"),
          namespaceSuspended: fc.constant(false),
          personOwned: fc.constant(namespace.personOwned),
        }),
      ),
      principal: fc.oneof(personAt(namespace.namespace), agentAt(namespace.namespace)),
    }),
  );

  /** What Bea, who has no role there, is told on asking for a member's, a maintainer's and an owner's right. */
  const refusalsAt = (namespace: NamespaceId): readonly string[] => {
    const at = into(namespace, { personOwned: !isId("agt", namespace) });
    const open = project(PRJ_1, "public", { namespace, personOwned: at.personOwned });
    return [
      decide(bea, "Operator_createProject", at),
      decide(bea, "Operator_putSettings", open),
      decide(bea, "Delivery_createCredential", at),
    ].map((decision) =>
      Result.isFailure(decision) && decision.failure._tag === "AccessRefused"
        ? `${decision.failure.reason}: ${decision.failure.nextActions.map((n) => n.title).join()}`
        : outcome(decision),
    );
  };

  it("[authz.own-namespace] a person's answers in their own namespace are an org owner's on the same resource in an org they own, and nobody else has a role there", () => {
    const placed = OWNED_ACTIONS.filter(
      (a) => kindOf(a) === "Namespace" || kindOf(a) === "Project",
    );
    fc.assert(
      fc.property(
        userArb,
        fc.constantFrom(...placed),
        fc.constantFrom(...PROJECTS),
        fc.constantFrom("private", "public"),
        rare(6),
        (drawn, action, projectId, visibility, suspended) => {
          const person: UserPrincipal = { ...drawn, memberships: [] };
          const owner: UserPrincipal = { ...drawn, memberships: [{ org: ORG_1, role: "owner" }] };
          const at = (namespace: NamespaceId): Resource =>
            kindOf(action) === "Project"
              ? project(projectId, visibility, { namespace, namespaceSuspended: suspended })
              : into(namespace, { suspended });
          const [theirs, orgs] = [at(person.userId), at(ORG_1)];
          return (
            outcome(decide(person, action, theirs)) === outcome(decide(owner, action, orgs)) &&
            [...rightsOf(person, theirs)].join() === [...rightsOf(owner, orgs)].join()
          );
        },
      ),
    );
    expect(ada.memberships).toEqual([]);
    const orgOwner = user({ userId: BEA, memberships: [{ org: ORG_1, role: "owner" }] });
    expect(rightsOf(ada, own())).toEqual(rightsOf(orgOwner, into(ORG_1)));
    expect(rightsOf(ada, hers)).toEqual(rightsOf(orgOwner, project(PRJ_1, "private")));
    expect(outcome(authorize(ada, "Operator_createProject", own()))).toBe("ok:");
    expect(outcome(authorize(ada, "Delivery_createCredential", own()))).toBe("ok:");
    expect(outcome(authorize(ada, "Operator_putSettings", hers))).toBe("ok:");
    expect(outcome(authorize(ada, "DeleteProject", hers))).toBe("ok:");
    expect(outcome(authorize(ada, "Namespaces_getProject", hers))).toBe("ok:members");
    // An agent she enrolled works there: she answers for it as its owner.
    const enrolled = agentOn(PRJ_1, {
      namespace: ADA,
      standing: invitedBy({ userId: ADA, role: "owner" }),
    });
    expect(outcome(authorize(enrolled, "declare", hers))).toBe("ok:");

    // To anyone else her private project is not there, and her namespace gives them no role.
    expect(outcome(authorize(bea, "Namespaces_getProject", hers))).toBe("404");
    expect(outcome(authorize(bea, "Operator_putSettings", hers))).toBe("404");
    expect(outcome(authorize(bea, "Operator_createProject", own()))).toBe("403:role");
    expect(outcome(authorize(ANON, "Namespaces_getNamespace", own()))).toBe("ok:public");
    // Her ban suspends her namespace: she has no rights in it, and to others it is not there.
    const banned = own({ suspended: true });
    expect(rightsOf(ada, banned).size).toBe(0);
    expect(rightsOf(user({ userId: ADA, suspended: true }), own()).size).toBe(0);
    expect(outcome(authorize(bea, "Namespaces_getNamespace", banned))).toBe("404");
  });

  it("[authz.org-rows] inviting, removing, making an owner and deleting are an org's own: of a person's or an agent's own namespace they are not there, for its owner as for anyone", () => {
    // Typed apart from the table: the rows that are asked of an org alone.
    const ORG_ROWS = [
      "DeleteOrg",
      "ManageMembers",
      "ManageOwners",
      "Namespaces_inviteAgent",
      "Namespaces_removeAgent",
    ];
    expect(ACTION_NAMES.filter((a) => kindOf(a) === "Org").toSorted()).toEqual(ORG_ROWS);
    fc.assert(
      fc.property(askedArb, fc.constantFrom(...ORG_ROWS.filter(isAction)), (asked, action) => {
        const on = decide(asked.principal, action, asked.namespace);
        return outcome(on) === "404";
      }),
    );
    const orgOwner = user({ userId: ADA, memberships: [{ org: ORG_1, role: "owner" }] });
    const governor = agentIn(BOT, { agentId: BOT, standing: GOVERNS });
    for (const action of ORG_ROWS.filter(isAction)) {
      expect([action, outcome(decide(orgOwner, action, into(ORG_1)))]).toEqual([action, "ok:"]);
      expect([action, outcome(decide(ada, action, own()))]).toEqual([action, "404"]);
      expect([action, outcome(decide(bea, action, own()))]).toEqual([action, "404"]);
      expect([action, outcome(decide(governor, action, bots))]).toEqual([action, "404"]);
      expect([action, outcome(decide(ANON, action, own()))]).toEqual([action, "401"]);
      expect([action, outcome(decide(ANON, action, bots))]).toEqual([action, "401"]);
    }
    // What is not about members stays the owner's, and the agent's in its own namespace; but a
    // namespace's credentials are a person's alone: no agent holds them, its own namespace included.
    expect(outcome(authorize(ada, "Delivery_createCredential", own()))).toBe("ok:");
    expect(outcome(authorize(governor, "Operator_createProject", bots))).toBe("ok:");
    expect(outcome(authorize(governor, "Delivery_createCredential", bots))).toBe("403:users-only");
  });

  it("[authz.no-member-right-off-org] nobody but its own account holds a member's, a maintainer's or an owner's right in a person's or an agent's own namespace, or on its projects", () => {
    fc.assert(
      fc.property(askedArb, ({ namespace, resource, principal }) => {
        const rights = rightsOf(principal, resource);
        return (
          idOf(principal) === namespace.namespace ||
          !(rights.has("member") || rights.has("maintain") || rights.has("own"))
        );
      }),
    );
    // The table walked: no governing action is granted to a stranger, whatever they say of themselves.
    const lying = user({ userId: BEA, memberships: [lyingMembership(ADA, "owner")] });
    const botsProject = project(PRJ_1, "public", { namespace: BOT, personOwned: false });
    const strangers: readonly (readonly [string, Principal, NamespaceResource, ProjectResource])[] =
      [
        ["a person with a membership in a person's namespace", lying, own(), hers],
        [
          "an agent said to govern a person's namespace nobody is marked as owning",
          agentOn(PRJ_1, { namespace: ADA, standing: GOVERNS }),
          own({ personOwned: false }),
          { ...hers, personOwned: false },
        ],
        [
          "an agent said to govern another agent's namespace",
          agentOn(PRJ_1, { agentId: OTHER_BOT, namespace: BOT, standing: GOVERNS }),
          bots,
          botsProject,
        ],
        [
          "a person with a membership in an agent's namespace",
          user({ userId: BEA, memberships: [lyingMembership(BOT, "owner")] }),
          bots,
          botsProject,
        ],
      ];
    const granted = strangers.flatMap(([name, principal, namespace, proj]) =>
      GOVERNING_ACTIONS.flatMap((action) => {
        const result = outcome(decide(principal, action, onNamespace(action) ? namespace : proj));
        return result.startsWith("ok:") ? [`${action} by ${name}`] : [];
      }),
    );
    expect(granted).toEqual([]);
    // Its own account governs an agent's namespace, and its projects on a token for them.
    const itself = agentOn(PRJ_1, { agentId: BOT, namespace: BOT, standing: GOVERNS });
    expect([...rightsOf(itself, bots)].toSorted()).toEqual(["maintain", "member", "own", "read"]);
    expect(rightsOf(itself, botsProject).has("own")).toBe(true);
  });

  it("[authz.role-refusal-by-kind] whoever lacks a role is told whom to ask in an org, and in a person's or an agent's own namespace that there is nobody to ask", () => {
    expect(refusalsAt(ORG_1)).toEqual([
      "role: Ask a member: this needs that role",
      "role: Ask a maintainer or an owner: this needs that role",
      "role: Ask an owner: this needs that role",
    ]);
    expect(refusalsAt(ADA)).toEqual([1, 2, 3].map(() => `role: ${nobodyToAsk("a person's own")}`));
    expect(refusalsAt(BOT)).toEqual([1, 2, 3].map(() => `role: ${nobodyToAsk("an agent's own")}`));
  });

  it("[authz.sponsor-own-namespace] in an agent's own namespace, where no person holds a role, the sponsor Keel asks sees what it is asked and answers it, of a private project too, and gains nothing else there; in an org a sponsor answers only as a member", () => {
    const PROJECT_ACTIONS = ACTION_NAMES.filter((a) => kindOf(a) === "Project");
    const ASKED_OF_A_SPONSOR = PROJECT_ACTIONS.filter((a) =>
      ["sponsorOrMaintain", "sponsorOrMaintainAsUser", "readMembersOrSponsor"].includes(needOf(a)),
    );
    let answered = 0;
    fc.assert(
      fc.property(
        userArb,
        fc.constantFrom(...PROJECT_ACTIONS),
        fc.option(fc.constantFrom(...USERS), { nil: undefined }),
        fc.constantFrom("private", "public"),
        rare(6),
        fc.constantFrom(...ASKED_OF_A_SPONSOR),
        (drawn, action, sponsor, visibility, suspended, question) => {
          // Every run opens with the sponsor itself, signed in and in good standing, asking what Keel asks a
          // sponsor: drawn freely, a sponsor meets that in about one run in a hundred, and a run that never
          // answers checks nothing of the answer. What follows is drawn freely.
          const self: UserPrincipal = { ...drawn, suspended: false, handle: drawn.handle ?? "ada" };
          const theirs = project(PRJ_1, visibility, {
            namespace: BOT,
            personOwned: false,
            sponsor: self.userId,
          });
          if (
            outcome(decide(self, question, theirs)) !==
            (needOf(question) === "readMembersOrSponsor" ? "ok:members" : "ok:")
          )
            return false;
          answered++;
          const bare = project(PRJ_1, visibility, {
            namespace: BOT,
            personOwned: false,
            namespaceSuspended: suspended,
          });
          const asked = sponsor === undefined ? bare : { ...bare, sponsor };
          const got = outcome(decide(drawn, action, asked));
          const need = needOf(action);
          const answers =
            (need === "sponsorOrMaintain" ||
              need === "sponsorOrMaintainAsUser" ||
              need === "readMembersOrSponsor") &&
            sponsor === drawn.userId &&
            !drawn.suspended &&
            drawn.handle !== undefined &&
            !suspended;
          if (!answers) return got === outcome(decide(drawn, action, bare));
          answered++;
          return got === (need === "readMembersOrSponsor" ? "ok:members" : "ok:");
        },
      ),
    );
    expect(answered).toBeGreaterThan(0);
    // The two Keel asks of the sponsor: the list of what it is asked, and the ruling.
    const theirs = project(PRJ_1, "private", { namespace: BOT, personOwned: false, sponsor: ADA });
    expect(outcome(decide(ada, "Operator_listEscalations", theirs))).toBe("ok:members");
    expect(outcome(decide(ada, "Operator_giveRuling", theirs))).toBe("ok:");
    expect(outcome(decide(ada, "Operator_getSettings", theirs))).toBe("404");
    expect(outcome(decide(bea, "Operator_giveRuling", theirs))).toBe("404");
    // A suspended namespace is not there for its sponsor, who is outside it.
    const suspended = { ...theirs, namespaceSuspended: true };
    expect(outcome(decide(ada, "Operator_giveRuling", suspended))).toBe("404");
    expect(outcome(decide(ada, "Operator_listEscalations", suspended))).toBe("404");
    // In an org, the sponsor of the agent concerned answers as a member, and is refused as anyone else is when not one.
    const inOrg = project(PRJ_1, "public", { sponsor: ADA });
    expect(outcome(decide(ada, "Operator_giveRuling", inOrg))).toBe("403:role");
    expect(outcome(decide(ada, "Operator_listEscalations", inOrg))).toBe("403:role");
    const member = user({
      userId: ADA,
      memberships: [{ org: asOrg(inOrg.namespace), role: "member" }],
    });
    expect(outcome(decide(member, "Operator_giveRuling", inOrg))).toBe("ok:");
  });

  it("[authz.person-owns] a person owns a person's namespace and an org, and an agent's own namespace is the agent's", () => {
    expect([personOwns("user"), personOwns("org"), personOwns("agent")]).toEqual([
      true,
      true,
      false,
    ]);
    expect([namespaceKind(ADA), namespaceKind(ORG_1), namespaceKind(BOT)]).toEqual([
      "user",
      "org",
      "agent",
    ]);
  });
});
