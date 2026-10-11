import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  type Action,
  type AgentPrincipal,
  authorize,
  type AuthorizationRefusal,
  BOOTSTRAP_ACTIONS,
  type ForkResource,
  type Grant,
  type MissingResource,
  NON_SPEC_ACTIONS,
  type Need,
  type OrgResource,
  type Principal,
  type ProjectResource,
  type Resource,
  type ResourceKind,
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
    instanceAdmin: rare(4),
    suspended: rare(8),
    memberships: membershipsArb,
  })
  .map(({ handled, ...u }) => ({ _tag: "User", ...u, ...(handled ? { handle: "ada" } : {}) }));

const scopesArb = fc.subarray<Scope>(["agent:work", "agent:read", "operator", "observer"]);
const agentArb: fc.Arbitrary<AgentPrincipal> = fc
  .record({
    projectId: fc.constantFrom(...PROJECTS),
    scopes: fc.oneof(fc.constant<Scope[]>(["agent:work", "agent:read"]), scopesArb),
    userId: fc.constantFrom(...USERS),
    role: fc.oneof(
      { weight: 4, arbitrary: roleArb },
      { weight: 1, arbitrary: fc.constant(undefined) },
    ),
    suspended: rare(8),
  })
  .map(({ projectId, scopes, userId, role, suspended }) => ({
    _tag: "Agent",
    agentId: makeId("agt", ulid(1)),
    org: orgOf(projectId),
    projectId,
    scopes,
    sponsor: { userId, suspended, ...(role === undefined ? {} : { role }) },
  }));

const principalArb: fc.Arbitrary<Principal> = fc.oneof(
  { weight: 4, arbitrary: userArb },
  { weight: 4, arbitrary: agentArb },
  { weight: 1, arbitrary: fc.constant<Principal>({ _tag: "Anonymous" }) },
  { weight: 1, arbitrary: fc.constant<Principal>({ _tag: "Bootstrap" }) },
);

const projectArb: fc.Arbitrary<ProjectResource> = fc
  .record({
    projectId: fc.constantFrom(...PROJECTS),
    visibility: fc.constantFrom("private", "public"),
    orgSuspended: rare(6),
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
});
const MISSING: MissingResource = { _tag: "Missing" };
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

/** Whether the principal is inside the org: a member, or an agent of it. */
const inside = (p: Principal, org: OrgId): boolean =>
  (p._tag === "User" && p.memberships.some((m) => m.org === org)) ||
  (p._tag === "Agent" && p.org === org);

const READS: ReadonlySet<Need> = new Set(["read", "readMembers"]);
const AGENT_NEEDS: ReadonlySet<Need> = new Set(["read", "readMembers", "work", "workOrMaintain"]);
const UNSCOPED: ReadonlySet<Need> = new Set(["anyone", "self", "user", "handle", "admin"]);

const user = (over: Partial<UserPrincipal> = {}): UserPrincipal => ({
  _tag: "User",
  userId: USERS[0] ?? makeId("usr", ulid(1)),
  handle: "ada",
  instanceAdmin: false,
  suspended: false,
  memberships: [],
  ...over,
});
const agentOn = (projectId: ProjectId, over: Partial<AgentPrincipal> = {}): AgentPrincipal => ({
  _tag: "Agent",
  agentId: makeId("agt", ulid(1)),
  org: orgOf(projectId),
  projectId,
  scopes: ["agent:work", "agent:read"],
  sponsor: { userId: USERS[1] ?? makeId("usr", ulid(2)), role: "member", suspended: false },
  ...over,
});
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
  ...over,
});
const ANON: Principal = { _tag: "Anonymous" };

/** The agent's sponsor as a user: a member of the agent's org in its role, or of none once it left. */
const sponsorOf = (a: AgentPrincipal): UserPrincipal =>
  user({
    userId: a.sponsor.userId,
    suspended: a.sponsor.suspended,
    memberships: a.sponsor.role === undefined ? [] : [{ org: a.org, role: a.sponsor.role }],
  });
const into = (org: OrgId): OrgResource => ({ _tag: "Org", org, suspended: false });

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

  it("[authz.agent-within-sponsor] an agent's rights never exceed its sponsor's", () => {
    fc.assert(
      fc.property(
        agentArb,
        fc.oneof(projectArb, orgResArb, fc.constant(MISSING)),
        (agent, resource) => {
          const sponsor = rightsOf(sponsorOf(agent), resource);
          return [...rightsOf(agent, resource)].every((r) =>
            sponsor.has(r === "work" ? "member" : r),
          );
        },
      ),
    );
    const suspended = agentOn(PRJ_1, {
      sponsor: { userId: USERS[1] ?? makeId("usr", ulid(2)), role: "owner", suspended: true },
    });
    expect([...rightsOf(suspended, project(PRJ_1, "private"))]).toEqual([]);
    expect([
      ...rightsOf(agentOn(PRJ_1), project(PRJ_1, "private", { orgSuspended: true })),
    ]).toEqual([]);
  });

  it("[authz.agent-own-project] an agent reads its own project as a member, any other as the public", () => {
    fc.assert(
      fc.property(
        agentArb,
        projectArb,
        fc.constantFrom(
          ...ACTION_NAMES.filter((a) => needOf(a) === "read" && kindOf(a) === "Project"),
        ),
        (agent, resource, action) => {
          const own = resource.projectId === agent.projectId && resource.org === agent.org;
          const result = outcome(decide(agent, action, resource));
          return result === "ok:members" ? own : !own || !result.startsWith("ok:");
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
  });

  it("[authz.sponsor-left] an agent whose sponsor left its org may do nothing there", () => {
    fc.assert(
      fc.property(agentArb, requestArb, (a, { action, resource }) => {
        const { role: _left, ...sponsor } = a.sponsor;
        const agent = { ...a, sponsor: { ...sponsor, suspended: false } };
        const result = outcome(decide(agent, action, resource));
        const need = needOf(action);
        if (need === "anyone" || need === "self") return result === "ok:";
        return result === (AGENT_NEEDS.has(need) ? "403:sponsor-left" : "403:users-only");
      }),
    );
    const { role: _left, ...gone } = agentOn(PRJ_1).sponsor;
    expect(
      outcome(authorize(agentOn(PRJ_1, { sponsor: gone }), "declare", project(PRJ_1, "public"))),
    ).toBe("403:sponsor-left");
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

  it("[authz.admin-not-reader] the instance admin reads nothing an ordinary user could not", () => {
    fc.assert(
      fc.property(userArb, requestArb, (u, { action, resource }) => {
        if (needOf(action) === "admin") return true;
        return (
          outcome(decide({ ...u, instanceAdmin: true }, action, resource)) ===
          outcome(decide({ ...u, instanceAdmin: false }, action, resource))
        );
      }),
    );
    const admin = user({ instanceAdmin: true });
    expect(outcome(authorize(admin, "Repo_getTree", project(PRJ_1, "private")))).toBe("404");
    expect(outcome(authorize(admin, "SuspendOrg", { _tag: "Instance" }))).toBe("ok:");
  });

  it("[authz.suspended] a suspended user, sponsor or org is refused, and an org's insiders are told why", () => {
    fc.assert(
      fc.property(principalArb, requestArb, (principal, { action, resource }) => {
        const result = outcome(decide(principal, action, resource));
        if (principal._tag === "User" && principal.suspended)
          return result === "403:user-suspended";
        if (principal._tag === "Agent" && principal.sponsor.suspended)
          return result === "403:sponsor-suspended";
        return true;
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
            p._tag === "User"
              ? { ...p, suspended: false, handle: "ada" }
              : { ...p, sponsor: { ...p.sponsor, suspended: false, role: "member" as const } };
          const need = needOf(action);
          const result = outcome(decide(principal, action, r));
          const scoped =
            principal._tag === "User"
              ? !UNSCOPED.has(need) && need !== "work"
              : AGENT_NEEDS.has(need);
          if (!scoped) return !result.startsWith("403:org-suspended") && result !== "404";
          return result === (inside(principal, r.org) ? "403:org-suspended" : "404");
        },
      ),
    );
    const member = agentOn(PRJ_1);
    expect(
      outcome(authorize(member, "declare", project(PRJ_1, "private", { orgSuspended: true }))),
    ).toBe("403:org-suspended");
    expect(outcome(authorize(user({ suspended: true }), "whoami", { _tag: "Self" }))).toBe(
      "403:user-suspended",
    );
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

  it("[authz.bootstrap-confined] the bootstrap credential may call exactly its three actions", () => {
    fc.assert(
      fc.property(requestArb, ({ action, resource }) => {
        const result = outcome(decide({ _tag: "Bootstrap" }, action, resource));
        return BOOTSTRAP_ACTIONS.has(action)
          ? result === "ok:"
          : result === "403:bootstrap-confined";
      }),
    );
    expect([...BOOTSTRAP_ACTIONS].toSorted()).toEqual([
      "Admin_createUser",
      "Auth_exchangeToken",
      "Operator_enrolAgent",
    ]);
    expect(
      outcome(authorize({ _tag: "Bootstrap" }, "Operator_putSettings", project(PRJ_1, "private"))),
    ).toBe("403:bootstrap-confined");
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
