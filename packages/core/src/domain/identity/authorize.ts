import { Result } from "effect";
import type { NextAction } from "../kernel/index.ts";
import { AccessRefused, AuthenticationRequired, NotVisible, type RefusalReason } from "./errors.ts";
import type {
  AgentPrincipal,
  ForkResource,
  InstanceResource,
  Membership,
  MissingResource,
  OrgResource,
  Principal,
  ProjectResource,
  Resource,
  Role,
  SelfResource,
  UserPrincipal,
} from "./tenancy.ts";

/**
 * What an action asks of its caller:
 * - `anyone`: no one is refused; `self`: any user or agent, on its own record;
 *   `user`: any user; `handle`: any user, even one without a handle yet;
 * - `read`: reads the resource (public projects to anyone, private ones to their
 *   org's members); `readMembers`: reads what only members see;
 * - `work`: an agent's work on its own project (agents only);
 *   `workOrMaintain`: that, or a maintainer's;
 * - `member`, `maintain`, `own`: that role or above in the resource's org
 *   (users only); `sponsorOrMaintain`: the sponsor of the agent concerned, or a
 *   maintainer;
 * - `admin`: the instance admin.
 */
export type Need =
  | "anyone"
  | "self"
  | "user"
  | "handle"
  | "read"
  | "readMembers"
  | "work"
  | "workOrMaintain"
  | "member"
  | "sponsorOrMaintain"
  | "maintain"
  | "own"
  | "admin";

/** The kind of resource an action is decided on. */
export type ResourceKind = "Instance" | "Self" | "Org" | "Project" | "Fork";

export interface ActionRule {
  readonly resource: ResourceKind;
  readonly need: Need;
}

const rule = <K extends ResourceKind, N extends Need>(resource: K, need: N) => ({ resource, need });

/** Every operation in the spec (`packages/contracts/openapi.json`), by its operationId. */
export const SPEC_ACTIONS = {
  Auth_exchangeToken: rule("Instance", "anyone"),
  Lattices_listLattices: rule("Instance", "anyone"),
  SignIn_methods: rule("Instance", "anyone"),
  whoami: rule("Self", "self"),
  inbox: rule("Self", "self"),

  Operator_listProjects: rule("Org", "read"),
  Operator_createProject: rule("Org", "member"),

  Changes_listChanges: rule("Project", "read"),
  change: rule("Project", "read"),
  status: rule("Project", "read"),
  nearby: rule("Project", "read"),
  why: rule("Project", "read"),
  Views_getCandidate: rule("Project", "read"),
  Views_getVerdict: rule("Project", "read"),
  Views_getTrunk: rule("Project", "read"),
  Views_listLanes: rule("Project", "read"),
  Conflicts_listConflicts: rule("Project", "read"),
  Conflicts_getConflict: rule("Project", "read"),
  Memory_listDecisions: rule("Project", "read"),
  Memory_getDecision: rule("Project", "read"),
  Inbox_listEvents: rule("Project", "read"),
  Inbox_getSnapshot: rule("Project", "read"),
  Repo_getBlob: rule("Project", "read"),
  Repo_listCommits: rule("Project", "read"),
  Repo_getCommit: rule("Project", "read"),
  Repo_getTree: rule("Project", "read"),

  Operator_getSettings: rule("Project", "readMembers"),
  Operator_listEscalations: rule("Project", "readMembers"),

  declare: rule("Project", "work"),
  adopt: rule("Project", "work"),
  rely: rule("Project", "work"),
  rebase: rule("Project", "work"),
  revise: rule("Project", "work"),
  submit: rule("Project", "work"),
  sketch: rule("Project", "work"),
  resolve: rule("Project", "work"),
  Sessions_openSession: rule("Project", "work"),
  Workspaces_releaseWorkspace: rule("Project", "work"),
  Workspaces_refreshWorkspaceToken: rule("Project", "work"),
  abandon: rule("Project", "workOrMaintain"),

  Operator_enrolAgent: rule("Project", "member"),
  Operator_giveRuling: rule("Project", "sponsorOrMaintain"),
  Operator_suspendAgent: rule("Project", "sponsorOrMaintain"),
  Operator_reinstateAgent: rule("Project", "sponsorOrMaintain"),
  Operator_revokeAgent: rule("Project", "sponsorOrMaintain"),
  Operator_putSettings: rule("Project", "maintain"),
} as const satisfies Record<string, ActionRule>;

/**
 * Actions decided by the same policy that are not operations in the spec: Better
 * Auth's own routes (R11 derives its org access control from these), the git
 * routes, and operations not yet in the spec. A lane that adds one of these to
 * the spec moves it to `SPEC_ACTIONS`; `[authz.spec-covered]` holds the split.
 */
export const NON_SPEC_ACTIONS = {
  SetHandle: rule("Self", "handle"),
  CreateOrg: rule("Instance", "user"),
  /** Invite, remove, or move a member between member and maintainer. */
  ManageMembers: rule("Org", "maintain"),
  /** Make or unmake an owner. */
  ManageOwners: rule("Org", "own"),
  DeleteOrg: rule("Org", "own"),
  ManageDeployTargets: rule("Project", "own"),
  DeleteProject: rule("Project", "own"),
  CloneRepo: rule("Project", "read"),
  /** Granted when the caller reads the source and is a member of the target org. */
  Operator_forkProject: rule("Fork", "member"),
  SuspendUser: rule("Instance", "admin"),
  ReinstateUser: rule("Instance", "admin"),
  SuspendOrg: rule("Instance", "admin"),
  ReinstateOrg: rule("Instance", "admin"),
  SetQuotas: rule("Instance", "admin"),
  HaltSpend: rule("Instance", "admin"),
  Admin_createUser: rule("Instance", "admin"),
} as const satisfies Record<string, ActionRule>;

export const ACTIONS = { ...SPEC_ACTIONS, ...NON_SPEC_ACTIONS } as const;
export type Action = keyof typeof ACTIONS;
export type SpecAction = keyof typeof SPEC_ACTIONS;

/** The resources an action of each kind is decided on. A project or an org may be missing. */
interface ResourceOfKind {
  readonly Instance: InstanceResource;
  readonly Self: SelfResource;
  readonly Org: OrgResource | MissingResource;
  readonly Project: ProjectResource | MissingResource;
  readonly Fork: ForkResource;
}
export type ResourceFor<A extends Action> = ResourceOfKind[(typeof ACTIONS)[A]["resource"]];

/**
 * What the bootstrap credential may call: exchange its secret, create the first
 * user, and (until P4) enrol an agent. Everything else is `bootstrap-confined`.
 */
export const BOOTSTRAP_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  "Auth_exchangeToken",
  "Admin_createUser",
  "Operator_enrolAgent",
]);

/** Who may see what a grant lets the caller read: everything members see, or only what is public. */
export type Audience = "members" | "public";

/** A granted request. `audience` is set on reads. */
export interface Grant {
  readonly audience?: Audience;
}

export type AuthorizationRefusal = AuthenticationRequired | NotVisible | AccessRefused;

/** What a principal may do on a resource. Governance by an agent is never one of them. */
export type Right = "read" | "work" | "member" | "maintain" | "own";

const ROLE_RIGHTS: Readonly<Record<Role, readonly Right[]>> = {
  owner: ["read", "member", "maintain", "own"],
  maintainer: ["read", "member", "maintain"],
  member: ["read", "member"],
};

const NONE: ReadonlySet<Right> = new Set();
const READ: ReadonlySet<Right> = new Set(["read"]);

const roleIn = (memberships: readonly Membership[], org: string): Role | undefined =>
  memberships.find((m) => m.org === org)?.role;

/** Rights from a role in the resource's org, else a public read. */
const rightsByRole = (role: Role | undefined, resource: Resource): ReadonlySet<Right> => {
  switch (resource._tag) {
    case "Project":
      if (resource.orgSuspended) return NONE;
      if (role !== undefined) return new Set(ROLE_RIGHTS[role]);
      return resource.visibility === "public" ? READ : NONE;
    case "Org":
      if (resource.suspended) return NONE;
      return role === undefined ? READ : new Set(ROLE_RIGHTS[role]);
    default:
      return NONE;
  }
};

const orgOf = (resource: Resource): string | undefined =>
  resource._tag === "Project" || resource._tag === "Org" ? resource.org : undefined;

/** The agent's sponsor's role in the agent's org: absent once the sponsor has left it. */
const sponsorRole = (agent: AgentPrincipal): Role | undefined => agent.sponsor.role;

const isOwnProject = (agent: AgentPrincipal, resource: Resource): boolean =>
  resource._tag === "Project" &&
  resource.org === agent.org &&
  resource.projectId === agent.projectId;

/**
 * An agent's rights: what its scopes allow on its own project, and a public
 * read elsewhere, always within what its sponsor may do. Work needs the sponsor
 * to be a member; `operator` and `observer` confer nothing.
 */
const agentRights = (agent: AgentPrincipal, resource: Resource): ReadonlySet<Right> => {
  if (agent.sponsor.suspended) return NONE;
  const sponsor = rightsByRole(sponsorRole(agent), resource);
  const own = isOwnProject(agent, resource);
  const rights = new Set<Right>();
  if (agent.scopes.includes("agent:read") && sponsor.has("read")) {
    const publicRead =
      resource._tag === "Org" || (resource._tag === "Project" && resource.visibility === "public");
    if (own || publicRead) rights.add("read");
  }
  if (own && agent.scopes.includes("agent:work") && sponsor.has("member")) rights.add("work");
  return rights;
};

/** What `principal` may do on `resource`, apart from any one action. */
export const rightsOf = (principal: Principal, resource: Resource): ReadonlySet<Right> => {
  switch (principal._tag) {
    case "User": {
      if (principal.suspended || principal.handle === undefined) return NONE;
      const org = orgOf(resource);
      return rightsByRole(
        org === undefined ? undefined : roleIn(principal.memberships, org),
        resource,
      );
    }
    case "Agent":
      return sponsorRole(principal) === undefined ? NONE : agentRights(principal, resource);
    case "Anonymous":
      return rightsByRole(undefined, resource);
    case "Bootstrap":
      return NONE;
    default: {
      const unreachable: never = principal;
      return unreachable;
    }
  }
};

type Decision = Result.Result<Grant, AuthorizationRefusal>;

const granted = (audience?: Audience): Decision =>
  Result.succeed(audience === undefined ? {} : { audience });

const hidden = (): Decision => Result.fail(new NotVisible());

const SIGN_IN: NextAction = {
  kind: "call",
  title: "Sign in, or exchange an agent's client credentials for a token",
  operationId: "Auth_exchangeToken",
};

const unauthenticated = (): Decision =>
  Result.fail(new AuthenticationRequired({ nextActions: [SIGN_IN] }));

const NEXT: Readonly<Record<Exclude<RefusalReason, "role">, NextAction>> = {
  "user-suspended": { kind: "escalate", title: "Ask the instance admin to reinstate your account" },
  "handle-required": { kind: "call", title: "Choose a handle first", operationId: "SetHandle" },
  "agents-only": {
    kind: "call",
    title: "Enrol an agent to do this work: work is done by agents",
    operationId: "Operator_enrolAgent",
  },
  "users-only": { kind: "escalate", title: "Ask your sponsor: only a person may do this" },
  "sponsor-suspended": {
    kind: "escalate",
    title: "Your sponsor is suspended; ask a member of the org to sponsor a new credential",
  },
  "sponsor-left": {
    kind: "escalate",
    title: "Your sponsor left the org; ask a member of the org to sponsor a new credential",
  },
  "org-suspended": { kind: "escalate", title: "Ask the instance admin to reinstate the org" },
  "foreign-project": {
    kind: "escalate",
    title: "This is not your project; ask your sponsor to enrol an agent in it",
  },
  scope: {
    kind: "call",
    title: "Exchange your credentials for a token with the scope this needs",
    operationId: "Auth_exchangeToken",
  },
  "bootstrap-confined": {
    kind: "call",
    title: "Create the first user, then act as that user",
    operationId: "Admin_createUser",
  },
  "private-source": {
    kind: "escalate",
    title: "A private project forks only into its own org; ask a maintainer to make it public",
  },
};

const refused = (reason: Exclude<RefusalReason, "role">): Decision =>
  Result.fail(new AccessRefused({ reason, nextActions: [NEXT[reason]] }));

const ROLE_NAMES: Readonly<Record<"member" | "maintain" | "own" | "admin", string>> = {
  member: "a member",
  maintain: "a maintainer or an owner",
  own: "an owner",
  admin: "the instance admin",
};

const lacksRole = (need: "member" | "maintain" | "own" | "admin"): Decision =>
  Result.fail(
    new AccessRefused({
      reason: "role",
      nextActions: [{ kind: "escalate", title: `Ask ${ROLE_NAMES[need]}: this needs that role` }],
    }),
  );

/** Whether a member of the resource's org is asking. Agents count as members of their own org. */
const insideOrg = (principal: UserPrincipal | AgentPrincipal, org: string): boolean =>
  principal._tag === "User"
    ? roleIn(principal.memberships, org) !== undefined
    : principal.org === org;

/**
 * Whether the resource is there for this caller to be refused: a private or
 * missing project, or anything of a suspended org, is NotVisible to outsiders,
 * so they cannot tell it from one that does not exist. Insiders of a suspended
 * org are told it is suspended.
 */
const notSeen = (
  principal: UserPrincipal | AgentPrincipal,
  resource: ProjectResource | OrgResource | MissingResource,
): Decision | undefined => {
  if (resource._tag === "Missing") return hidden();
  const inside = insideOrg(principal, resource.org);
  const suspended = resource._tag === "Org" ? resource.suspended : resource.orgSuspended;
  if (suspended) return inside ? refused("org-suspended") : hidden();
  if (resource._tag === "Project" && resource.visibility === "private" && !inside) return hidden();
  return undefined;
};

const anonymous = (need: Need, resource: Resource): Decision => {
  if (need === "anyone") return granted();
  if (need !== "read") return unauthenticated();
  return rightsOf({ _tag: "Anonymous" }, resource).has("read") ? granted("public") : hidden();
};

const fork = (user: UserPrincipal, resource: ForkResource): Decision => {
  const source = notSeen(user, resource.source);
  if (source !== undefined) return source;
  const target = notSeen(user, resource.target);
  if (target !== undefined) return target;
  if (!rightsOf(user, resource.target).has("member")) return lacksRole("member");
  const { source: project } = resource;
  if (
    project._tag === "Project" &&
    project.visibility === "private" &&
    project.org !== resource.target.org
  )
    return refused("private-source");
  return granted();
};

const user = (principal: UserPrincipal, need: Need, resource: Resource): Decision => {
  if (principal.suspended) return refused("user-suspended");
  if (need === "handle") return granted();
  if (principal.handle === undefined) return refused("handle-required");
  switch (need) {
    case "anyone":
    case "self":
    case "user":
      return granted();
    case "admin":
      return principal.instanceAdmin ? granted() : lacksRole("admin");
    case "work":
      return refused("agents-only");
    default:
      break;
  }
  if (resource._tag === "Fork") return fork(principal, resource);
  if (resource._tag !== "Project" && resource._tag !== "Org" && resource._tag !== "Missing")
    return hidden();
  const unseen = notSeen(principal, resource);
  if (unseen !== undefined) return unseen;
  const rights = rightsOf(principal, resource);
  switch (need) {
    case "read":
      return granted(rights.has("member") ? "members" : "public");
    case "readMembers":
      return rights.has("member") ? granted("members") : lacksRole("member");
    case "member":
      return rights.has("member") ? granted() : lacksRole("member");
    case "maintain":
    case "workOrMaintain":
      return rights.has("maintain") ? granted() : lacksRole("maintain");
    case "own":
      return rights.has("own") ? granted() : lacksRole("own");
    case "sponsorOrMaintain":
      return rights.has("maintain") ||
        (rights.has("member") &&
          resource._tag === "Project" &&
          resource.sponsor === principal.userId)
        ? granted()
        : lacksRole("maintain");
    default:
      return hidden();
  }
};

const agent = (principal: AgentPrincipal, need: Need, resource: Resource): Decision => {
  if (principal.sponsor.suspended) return refused("sponsor-suspended");
  switch (need) {
    case "anyone":
    case "self":
      return granted();
    case "read":
    case "readMembers":
    case "work":
    case "workOrMaintain":
      break;
    default:
      return refused("users-only");
  }
  if (sponsorRole(principal) === undefined) return refused("sponsor-left");
  if (resource._tag !== "Project" && resource._tag !== "Org" && resource._tag !== "Missing")
    return hidden();
  const unseen = notSeen(principal, resource);
  if (unseen !== undefined) return unseen;
  const own = isOwnProject(principal, resource);
  if (!own && resource._tag === "Project" && (need !== "read" || resource.visibility === "private"))
    return refused("foreign-project");
  if (resource._tag === "Org" && need !== "read") return refused("foreign-project");
  const rights = rightsOf(principal, resource);
  if (need === "read" || need === "readMembers")
    return rights.has("read") ? granted(own ? "members" : "public") : refused("scope");
  return rights.has("work") ? granted() : refused("scope");
};

/**
 * The one authorization policy: whether `principal` may take `action` on
 * `resource`. It decides from its arguments alone;
 * the gate fills them from the request and the Memberships port, and never
 * from events.
 *
 * - 401 `AuthenticationRequired`: an anonymous caller asking for anything but a
 *   public read.
 * - 404 `NotVisible`: a private project of an org the caller is not in, a
 *   missing one, or anything of a suspended org to an outsider. It carries no
 *   fields: the gate answers the operation's own not-found, so a private
 *   resource and a missing one read the same.
 * - 403 `AccessRefused`: the caller sees the resource but may not do this, with
 *   a reason and next actions. A foreign project in the agent's own org is
 *   `foreign-project`; one in another org is NotVisible.
 *
 * Work is agents' only, and governance users' only. An agent never exceeds its
 * sponsor. The bootstrap credential may call `BOOTSTRAP_ACTIONS` and nothing else.
 */
export const authorize = <A extends Action>(
  principal: Principal,
  action: A,
  resource: ResourceFor<A>,
): Decision => {
  const { need } = ACTIONS[action];
  switch (principal._tag) {
    case "Bootstrap":
      return BOOTSTRAP_ACTIONS.has(action) ? granted() : refused("bootstrap-confined");
    case "Anonymous":
      return anonymous(need, resource);
    case "User":
      return user(principal, need, resource);
    case "Agent":
      return agent(principal, need, resource);
    default: {
      const unreachable: never = principal;
      return unreachable;
    }
  }
};
