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
  type MemberStanding,
  type MissingResource,
  NON_SPEC_ACTIONS,
  type Need,
  type OrgResource,
  type Principal,
  type ProjectResource,
  type Resource,
  type ResourceKind,
  type Right,
  type Role,
  rightsOf,
  type Scope,
  SPEC_ACTIONS,
  type UserPrincipal,
} from "../../../src/domain/identity/index.ts";
import { makeId, type OrgId, type ProjectId } from "../../../src/domain/kernel/index.ts";
import { fc } from "../../support/fast-check.ts";

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
      org: orgOf(projectId),
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
        .map(([{ projectId: _none, ...a }, org]) => ({ ...a, org })),
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
    orgSuspended: rare(6),
    personOwned: fc.boolean(),
    sponsor: fc.option(fc.constantFrom(...USERS), { nil: undefined }),
  })
  .map(({ sponsor, ...p }) => ({
    _tag: "Project",
    org: orgOf(p.projectId),
    ...p,
    ...(sponsor === undefined ? {} : { sponsor }),
  }));
const orgResArb: fc.Arbitrary<OrgResource> = fc.record({
  _tag: fc.constant("Org"),
  org: fc.constantFrom(...ORGS),
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
    case "Org":
      return fc.oneof(
        { weight: 6, arbitrary: orgResArb },
        { weight: 1, arbitrary: fc.constant(MISSING) },
      );
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
const inside = (p: Principal, org: OrgId): boolean =>
  (p._tag === "User" && p.memberships.some((m) => m.org === org)) ||
  (p._tag === "Agent" && p.org === org && p.standing._tag !== "None");

const READS: ReadonlySet<Need> = new Set(["read", "readMembers"]);
const GOVERNING: ReadonlySet<Need> = new Set(["member", "maintain", "own", "sponsorOrMaintain"]);
const PEOPLES: readonly Right[] = ["member", "maintain", "own"];
const UNSCOPED: ReadonlySet<Need> = new Set(["anyone", "self", "account", "user", "handle"]);

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
  org: orgOf(projectId),
  projectId,
  scopes: ["agent:work", "agent:read"],
  paused: false,
  standing: invitedBy(),
  ...over,
});
/** An agent whose token names no project: it stands in `org` alone, invited unless `over` says otherwise. */
const agentIn = (org: OrgId, over: Partial<AgentPrincipal> = {}): AgentPrincipal => {
  const { projectId: _none, ...a } = agentOn(PRJ_1);
  return { ...a, org, ...over };
};
/** A project a person owns, unless `over` says otherwise. */
const project = (
  projectId: ProjectId,
  visibility: "private" | "public",
  over: Partial<ProjectResource> = {},
): ProjectResource => ({
  _tag: "Project",
  org: orgOf(projectId),
  projectId,
  visibility,
  orgSuspended: false,
  personOwned: true,
  ...over,
});
const ANON: Principal = { _tag: "Anonymous" };

/** The member who invited an agent, as a user: a member of the agent's org in its role, or of none once it left. */
const inviterOf = (a: AgentPrincipal, by: MemberStanding): UserPrincipal =>
  user({
    userId: by.userId,
    suspended: by.suspended,
    memberships: by.role === undefined ? [] : [{ org: a.org, role: by.role }],
  });
/** An org a person owns, unless `over` says otherwise. */
const into = (org: OrgId, over: Partial<OrgResource> = {}): OrgResource => ({
  _tag: "Org",
  org,
  suspended: false,
  personOwned: true,
  ...over,
});

/** Whether the resource is the project the agent's token is for. */
const tokenProject = (a: AgentPrincipal, resource: Resource): boolean =>
  resource._tag === "Project" && resource.projectId === a.projectId && resource.org === a.org;

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
  (tokenProject(a, resource) || (resource._tag === "Org" && resource.org === a.org)) &&
  (resource._tag === "Project" || resource._tag === "Org") &&
  !resource.personOwned;

/** Whether the principal holds an owner's rights on the resource: a user who owns its org, or the agent that governs it. */
const owns = (principal: Principal, resource: ProjectResource | OrgResource): boolean =>
  principal._tag === "Agent"
    ? governs(principal, resource)
    : principal._tag === "User" &&
      principal.memberships.some((m) => m.org === resource.org && m.role === "owner");

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
        : inside(principal, resource.org);
    case "Org":
      return principal._tag === "Agent"
        ? governs(principal, resource)
        : inside(principal, resource.org);
    case "Fork":
      return principal._tag === "User" && inside(principal, resource.target.org);
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
/** The actions decided on a project or an org, by kind. */
const actionsOn = (kind: "Project" | "Org"): readonly Action[] =>
  ACTION_NAMES.filter((a) => kindOf(a) === kind);
const placedArb = fc.oneof(projectArb, orgResArb);

const subset = (rights: ReadonlySet<Right>, of: ReadonlySet<Right>): boolean =>
  [...rights].every((r) => of.has(r));
const READ_WORK: ReadonlySet<Right> = new Set(["read", "work"]);
/** Whether the resource's org is suspended. */
const shut = (resource: ProjectResource | OrgResource): boolean =>
  resource._tag === "Org" ? resource.suspended : resource.orgSuspended;
/**
 * What an action is decided on where the agent governs and no person owns: its
 * token's project, or the namespace itself. None when the action is a project's
 * and the token names no project.
 */
const governed = (
  agent: AgentPrincipal,
  action: Action,
  proj: ProjectResource,
  org: OrgResource,
): ProjectResource | OrgResource | undefined => {
  if (kindOf(action) === "Org")
    return { ...org, org: agent.org, suspended: false, personOwned: false };
  return agent.projectId === undefined
    ? undefined
    : {
        ...proj,
        projectId: agent.projectId,
        org: agent.org,
        orgSuspended: false,
        personOwned: false,
      };
};
/** The actions that ask for a governing right, on a project or an org. */
const GOVERNING_ACTIONS = [...actionsOn("Project"), ...actionsOn("Org")].filter((a) =>
  GOVERNING.has(needOf(a)),
);

describe("authorize", () => {
  it("[authz.org-isolation] no principal reads a private project of an org it is not in", () => {
    fc.assert(
      fc.property(
        principalArb,
        projectArb,
        fc.constantFrom(...ACTION_NAMES.filter((a) => READS.has(needOf(a)))),
        (principal, resource, action) => {
          const p = { ...resource, visibility: "private" as const };
          return inside(principal, p.org) || Result.isFailure(decide(principal, action, p));
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
            inside(principal, p.org) ||
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
        const p = { ...resource, visibility: "public" as const, orgSuspended: false };
        return outcome(authorize(ANON, "Repo_getTree", p)) === "ok:public";
      }),
    );
    expect(outcome(authorize(ANON, "Repo_getTree", project(PRJ_1, "public")))).toBe("ok:public");
    expect(outcome(authorize(ANON, "Repo_getTree", project(PRJ_1, "private")))).toBe("404");
    expect(outcome(authorize(ANON, "declare", project(PRJ_1, "public")))).toBe("401");
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
            !resource.orgSuspended;
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
          const resource = { ...p, projectId: a.projectId, org: a.org, orgSuspended: false };
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
      ...rightsOf(agentOn(PRJ_1), project(PRJ_1, "private", { orgSuspended: true })),
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

  it("[authz.agent-paused] a paused agent has no rights and is refused everything, told that it is paused", () => {
    fc.assert(
      fc.property(agentArb, requestArb, (a, { action, resource }) => {
        const paused = { ...a, paused: true };
        const result = decide(paused, action, resource);
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
    expect(outcome(authorize(paused, "whoami", { _tag: "Self" }))).toBe("403:agent-paused");
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
          const namespace = into(agent.org);
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

  it("[authz.agent-governs-its-own] where it governs and no person owns, an agent is granted whatever an owner is and its own work, on its token's project and the namespace itself", () => {
    fc.assert(
      fc.property(
        agentWith(fc.constant(GOVERNS)),
        projectArb,
        orgResArb,
        fc.constantFrom(...actionsOn("Project"), ...actionsOn("Org")),
        (a, proj, org, action) => {
          const agent = { ...a, paused: false };
          const resource = governed(agent, action, proj, org);
          if (resource === undefined) {
            // Its token names no project: every project of its namespace is the public's to it.
            const any = { ...proj, org: agent.org, orgSuspended: false, personOwned: false };
            const result = outcome(decide(agent, action, any));
            return (
              subset(rightsOf(agent, any), rightsOf(ANON, any)) &&
              (!result.startsWith("ok:") || (result === "ok:public" && needOf(action) === "read"))
            );
          }
          const owner = user({ memberships: [{ org: agent.org, role: "owner" }] });
          const theirs = outcome(decide(owner, action, resource));
          const its = outcome(decide(agent, action, resource));
          const need = needOf(action);
          // Its scopes cap its reading and its work, and nothing else.
          if (need === "work")
            return its === (agent.scopes.includes("agent:work") ? "ok:" : "403:scope");
          if (READS.has(need))
            return its === (agent.scopes.includes("agent:read") ? theirs : "403:scope");
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
          tokenProject(agent, resource) || (resource._tag === "Org" && resource.org === agent.org);
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
      maintain: 2,
      workOrMaintain: 2,
      sponsorOrMaintain: 2,
      own: 3,
    };
    fc.assert(
      fc.property(
        roleArb,
        fc.oneof(projectArb, orgResArb),
        fc.constantFrom(
          ...ACTION_NAMES.filter(
            (a) =>
              NEEDED[needOf(a)] !== undefined && (kindOf(a) === "Project" || kindOf(a) === "Org"),
          ),
        ),
        (role, resource, action) => {
          const r =
            resource._tag === "Project"
              ? { ...resource, orgSuspended: false, sponsor: USERS[2] ?? makeId("usr", ulid(3)) }
              : { ...resource, suspended: false };
          if (kindOf(action) !== r._tag) return true;
          const u = user({ memberships: [{ org: r.org, role }] });
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

  it("[authz.member-management] a maintainer manages members but not owners, and only an owner deletes the org", () => {
    fc.assert(
      fc.property(roleArb, orgResArb, (role, resource) => {
        const org = { ...resource, suspended: false };
        const u = user({ memberships: [{ org: org.org, role }] });
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

  it("[authz.deploy-owner-only] only an owner of the org, or the agent that governs it, sets a project's deploy targets or touches the org's credentials", () => {
    fc.assert(
      fc.property(principalArb, projectArb, orgResArb, (principal, proj, org) => {
        const targets = outcome(decide(principal, "ManageDeployTargets", proj)).startsWith("ok:");
        const credentials = outcome(decide(principal, "ManageCredentials", org)).startsWith("ok:");
        return (!targets || owns(principal, proj)) && (!credentials || owns(principal, org));
      }),
    );
    const owner = user({ memberships: [{ org: ORG_1, role: "owner" }] });
    const maintainer = user({ memberships: [{ org: ORG_1, role: "maintainer" }] });
    const mine = project(PRJ_1, "private");
    expect(outcome(authorize(owner, "ManageDeployTargets", mine))).toBe("ok:");
    expect(outcome(authorize(owner, "ManageCredentials", into(ORG_1)))).toBe("ok:");
    expect(outcome(authorize(maintainer, "ManageDeployTargets", mine))).toBe("403:role");
    expect(outcome(authorize(maintainer, "ManageCredentials", into(ORG_1)))).toBe("403:role");
    expect(outcome(authorize(owner, "ManageCredentials", into(ORG_2)))).not.toBe("ok:");
    const governor = agentOn(PRJ_1, { standing: GOVERNS });
    expect(outcome(authorize(governor, "ManageDeployTargets", mine))).toBe("403:users-only");
    expect(outcome(authorize(governor, "ManageCredentials", into(ORG_1)))).toBe("403:users-only");
    expect(
      outcome(authorize(governor, "ManageCredentials", into(ORG_1, { personOwned: false }))),
    ).toBe("ok:");
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

  it("[authz.no-instance-role] nothing is decided on the instance but signing in, the lattices and making an org", () => {
    const onInstance = Object.entries(ACTIONS)
      .filter(([, rule]) => rule.resource === "Instance")
      .map(([action, rule]) => `${action}: ${rule.need}`)
      .toSorted();
    expect(onInstance).toEqual([
      "Auth_exchangeToken: anyone",
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
        const who = personOwned || kind !== "Org" ? [...strangers, ...governors] : strangers;
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
              ? { ...resource, orgSuspended: true }
              : { ...resource, suspended: true };
          if (kindOf(action) !== r._tag) return true;
          const principal =
            p._tag === "User" ? { ...p, suspended: false, handle: "ada" } : { ...p, paused: false };
          const need = needOf(action);
          const result = outcome(decide(principal, action, r));
          const scoped = !UNSCOPED.has(need) && (principal._tag === "Agent" || need !== "work");
          if (!scoped) return !result.startsWith("403:org-suspended") && result !== "404";
          return result === (inside(principal, r.org) ? "403:org-suspended" : "404");
        },
      ),
    );
    const member = agentOn(PRJ_1);
    expect(
      outcome(authorize(member, "declare", project(PRJ_1, "private", { orgSuspended: true }))),
    ).toBe("403:org-suspended");
    expect(
      outcome(
        authorize(
          agentOn(PRJ_1, { standing: NO_STANDING }),
          "declare",
          project(PRJ_1, "public", { orgSuspended: true }),
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
          const rights = [...rightsOf(principal, resource)];
          return (
            outcome(decide(principal, action, resource)) ===
              onAccount(principal, needOf(action), resource) &&
            rights.every((right) => right === "read")
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
    // An owner of the org the agent works in, who does not stand behind it.
    const owner = user({ userId: cy, memberships: [{ org: ORG_1, role: "owner" }] });
    const itself = agentOn(PRJ_1);
    const another = agentOn(PRJ_1, { agentId: OTHER_BOT });
    const moves = ["Operator_suspendAgent", "Operator_reinstateAgent", "Agents_endSponsorship"];
    const read = (who: Principal, on: AgentResource | MissingResource = account) =>
      moves.filter(isAction).map((move) => outcome(decide(who, move, on)));
    expect(read(sponsor)).toEqual(["ok:", "ok:", "ok:"]);
    // Whoever does not stand behind it cannot tell it from an agent that does not exist.
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
          !source.orgSuspended &&
          (source.visibility === "public" || inside(u, source.org));
        if (!readable)
          return source._tag === "Project" && source.orgSuspended && inside(u, source.org)
            ? result === "403:org-suspended"
            : result === "404";
        const granted =
          !target.suspended &&
          inside(u, target.org) &&
          (source.visibility === "public" || source.org === target.org);
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
