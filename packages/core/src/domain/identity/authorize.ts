import { Result } from "effect";
import type { NextAction } from "../kernel/index.ts";
import { AccessRefused, AuthenticationRequired, NotVisible, type RefusalReason } from "./errors.ts";
import type {
  AgentPrincipal,
  AgentStanding,
  ForkResource,
  InstanceResource,
  Membership,
  MemberStanding,
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
 *   `account`: any user or agent; `user`: any user; `handle`: any user, even
 *   one without a handle yet;
 * - `read`: reads the resource (public projects to anyone, private ones to their
 *   org's members); `readMembers`: reads what only members see;
 * - `work`: an agent's work on its token's project (agents only);
 *   `workOrMaintain`: that, or a maintainer's;
 * - `member`, `maintain`, `own`: that role or above in the resource's org, or
 *   an agent where it governs and no person owns; `sponsorOrMaintain`: the
 *   sponsor of the agent concerned, or whoever holds `maintain`.
 */
export type Need =
  | "anyone"
  | "self"
  | "account"
  | "user"
  | "handle"
  | "read"
  | "readMembers"
  | "work"
  | "workOrMaintain"
  | "member"
  | "sponsorOrMaintain"
  | "maintain"
  | "own";

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
  Users_me: rule("Self", "user"),

  Operator_listProjects: rule("Org", "read"),
  Operator_createProject: rule("Org", "member"),
  Orgs_getProject: rule("Project", "read"),

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
  Probes_getProbeSource: rule("Project", "read"),
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
  CreateOrg: rule("Instance", "account"),
  /** Invite, remove, or move a member between member and maintainer. */
  ManageMembers: rule("Org", "maintain"),
  /** Make or unmake an owner. */
  ManageOwners: rule("Org", "own"),
  DeleteOrg: rule("Org", "own"),
  /** Set, clear or list a project's deploy targets. */
  ManageDeployTargets: rule("Project", "own"),
  /** Store, replace or delete a credential in the org's store; none is ever read back. */
  ManageCredentials: rule("Org", "own"),
  DeleteProject: rule("Project", "own"),
  CloneRepo: rule("Project", "read"),
  /** Granted when the caller reads the source and is a member of the target org. */
  Operator_forkProject: rule("Fork", "member"),
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

/** Who may see what a grant lets the caller read: everything members see, or only what is public. */
export type Audience = "members" | "public";

/** A granted request. `audience` is set on reads. */
export interface Grant {
  readonly audience?: Audience;
}

export type AuthorizationRefusal = AuthenticationRequired | NotVisible | AccessRefused;

/** What a principal may do on a resource. */
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

/** Whether the resource is the project the agent's token is for. A token that names none is for no project. */
const isTokenProject = (agent: AgentPrincipal, resource: Resource): boolean =>
  resource._tag === "Project" &&
  resource.org === agent.org &&
  resource.projectId === agent.projectId;

/** Whether the member who invited an agent still answers for it: a member of the org, not suspended. */
const answers = (by: MemberStanding): boolean => by.role !== undefined && !by.suspended;

/**
 * The standing an agent brings to a resource. A token is for at most one
 * project, so its standing in the namespace counts on that project and on the
 * namespace itself, never on another of its projects. Everywhere else, and once
 * its inviter no longer answers for it, the agent is the public.
 */
const standingOn = (
  agent: AgentPrincipal,
  resource: ProjectResource | OrgResource,
): AgentStanding["_tag"] => {
  const { standing } = agent;
  if (resource.org !== agent.org) return "None";
  if (resource._tag === "Project" && resource.projectId !== agent.projectId) return "None";
  return standing._tag === "Invited" && !answers(standing.by) ? "None" : standing._tag;
};

/** The rights of whoever governs. Where a person owns, they are people's alone. */
const GOVERNING: readonly Right[] = ["member", "maintain", "own"];

/**
 * An agent's rights, by where it stands: everything where it
 * governs, `read` and `work` on its token's project where a member invited it,
 * and a read of what is public anywhere else. A paused agent has none. Its
 * scopes cap `read` and `work`; `operator` and `observer` confer nothing.
 *
 * No agent governs where a person owns: on such a resource `member`, `maintain`
 * and `own` are taken out last, whatever the standing says, so the rule does
 * not rest on the gate having filled the standing truthfully.
 */
const agentRights = (agent: AgentPrincipal, resource: Resource): ReadonlySet<Right> => {
  if (agent.paused) return NONE;
  if (resource._tag !== "Project" && resource._tag !== "Org") return NONE;
  if (resource._tag === "Org" ? resource.suspended : resource.orgSuspended) return NONE;
  const standing = standingOn(agent, resource);
  const rights = new Set<Right>();
  if (resource._tag === "Org" || resource.visibility === "public") rights.add("read");
  if (standing !== "None") rights.add("read");
  if (standing !== "None" && resource._tag === "Project") rights.add("work");
  if (standing === "Governs") for (const right of GOVERNING) rights.add(right);
  if (!agent.scopes.includes("agent:read")) rights.delete("read");
  if (!agent.scopes.includes("agent:work")) rights.delete("work");
  if (resource.personOwned) for (const right of GOVERNING) rights.delete(right);
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
      return agentRights(principal, resource);
    case "Anonymous":
      return rightsByRole(undefined, resource);
    default: {
      const unreachable: never = principal;
      return unreachable;
    }
  }
};

export type Decision = Result.Result<Grant, AuthorizationRefusal>;

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
  "user-suspended": {
    kind: "escalate",
    title: "Ask whoever runs this Keel to reinstate your account",
  },
  "handle-required": { kind: "call", title: "Choose a handle first", operationId: "SetHandle" },
  "agents-only": {
    kind: "call",
    title: "Enrol an agent to do this work: work is done by agents",
    operationId: "Operator_enrolAgent",
  },
  "users-only": {
    kind: "escalate",
    title: "Ask a person: an agent may not do this, and governs nothing a person owns",
  },
  "agent-paused": {
    kind: "escalate",
    title:
      "You are paused; ask your sponsor, or a maintainer of your project's org, to reinstate you",
  },
  "inviter-suspended": {
    kind: "escalate",
    title:
      "The member who answers for you in this org is suspended; ask another member to invite you",
  },
  "inviter-left": {
    kind: "escalate",
    title: "The member who answers for you in this org left it; ask a member to invite you",
  },
  "org-suspended": { kind: "escalate", title: "Ask whoever runs this Keel to reinstate the org" },
  "foreign-project": {
    kind: "escalate",
    title:
      "Your token is for another project, or you have no standing in this one; use a token for it, or ask a member of its org to invite you",
  },
  scope: {
    kind: "call",
    title: "Exchange your credentials for a token with the scope this needs",
    operationId: "Auth_exchangeToken",
  },
  "private-source": {
    kind: "escalate",
    title: "A private project forks only into its own org; ask a maintainer to make it public",
  },
};

const refused = (reason: Exclude<RefusalReason, "role">): Decision =>
  Result.fail(new AccessRefused({ reason, nextActions: [NEXT[reason]] }));

const ROLE_NAMES: Readonly<Record<"member" | "maintain" | "own", string>> = {
  member: "a member",
  maintain: "a maintainer or an owner",
  own: "an owner",
};

const lacksRole = (need: "member" | "maintain" | "own"): Decision =>
  Result.fail(
    new AccessRefused({
      reason: "role",
      nextActions: [{ kind: "escalate", title: `Ask ${ROLE_NAMES[need]}: this needs that role` }],
    }),
  );

/**
 * Whether a member of the resource's org is asking. An agent counts as inside
 * the org of its token's project while it has a standing there, also one whose
 * inviter no longer answers for it: it is told why it is refused.
 */
const insideOrg = (principal: UserPrincipal | AgentPrincipal, org: string): boolean =>
  principal._tag === "User"
    ? roleIn(principal.memberships, org) !== undefined
    : principal.org === org && principal.standing._tag !== "None";

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
    case "account":
    case "user":
      return granted();
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

/** Why an agent may not read or work on what it sees. */
const whyNoWork = (
  agent: AgentPrincipal,
  resource: ProjectResource | OrgResource,
): Exclude<RefusalReason, "role"> => {
  if (!isTokenProject(agent, resource)) return "foreign-project";
  const { standing } = agent;
  switch (standing._tag) {
    case "Invited":
      if (standing.by.suspended) return "inviter-suspended";
      return standing.by.role === undefined ? "inviter-left" : "scope";
    case "Governs":
      return "scope";
    default:
      return "foreign-project";
  }
};

/**
 * Why an agent may not govern what it sees: only a person may, or it governs
 * the namespace and its token is for another of its projects.
 */
const whyNoRule = (
  agent: AgentPrincipal,
  resource: ProjectResource | OrgResource,
): Exclude<RefusalReason, "role"> =>
  agent.standing._tag === "Governs" && resource.org === agent.org && !resource.personOwned
    ? "foreign-project"
    : "users-only";

const agent = (principal: AgentPrincipal, need: Need, resource: Resource): Decision => {
  if (principal.paused) return refused("agent-paused");
  switch (need) {
    case "anyone":
    case "self":
    case "account":
      return granted();
    case "user":
    case "handle":
      return refused("users-only");
    default:
      break;
  }
  if (resource._tag === "Fork") return refused("users-only");
  if (resource._tag !== "Project" && resource._tag !== "Org") return hidden();
  const unseen = notSeen(principal, resource);
  if (unseen !== undefined) return unseen;
  const rights = rightsOf(principal, resource);
  const asMember =
    rights.has("member") ||
    (resource._tag === "Project" && standingOn(principal, resource) !== "None");
  switch (need) {
    case "read":
      if (rights.has("read")) return granted(asMember ? "members" : "public");
      return refused(
        resource._tag === "Org" || resource.visibility === "public"
          ? "scope"
          : whyNoWork(principal, resource),
      );
    case "readMembers":
      return rights.has("read") && asMember
        ? granted("members")
        : refused(whyNoWork(principal, resource));
    case "work":
      return rights.has("work") ? granted() : refused(whyNoWork(principal, resource));
    case "workOrMaintain":
      return rights.has("work") || rights.has("maintain")
        ? granted()
        : refused(whyNoWork(principal, resource));
    case "member":
    case "maintain":
    case "own":
      return rights.has(need) ? granted() : refused(whyNoRule(principal, resource));
    case "sponsorOrMaintain":
      return rights.has("maintain") ? granted() : refused(whyNoRule(principal, resource));
    default:
      return hidden();
  }
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
 *   a reason and next actions. A private project of the agent's org that its
 *   token is not for is `foreign-project`; one in another org is NotVisible.
 *
 * Work is agents' only. Governance is people's wherever a person owns: an agent
 * governs only its own namespace, or an org it created that no person owns, and
 * an agent a member invited works and never governs. A sponsor gives an agent
 * no rights. No principal stands above an org's owners: there is no instance
 * role.
 */
export const authorize = <A extends Action>(
  principal: Principal,
  action: A,
  resource: ResourceFor<A>,
): Decision => {
  const { need } = ACTIONS[action];
  switch (principal._tag) {
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
