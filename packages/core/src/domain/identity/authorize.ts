import { Result } from "effect";
import {
  type NamespaceId,
  type NamespaceKind,
  namespaceKind,
  type NextAction,
  type ProjectId,
} from "../kernel/index.ts";
import { AccessRefused, AuthenticationRequired, NotVisible, type RefusalReason } from "./errors.ts";
import type {
  AgentPrincipal,
  AgentResource,
  AgentStanding,
  ForkResource,
  InstanceResource,
  Membership,
  MemberStanding,
  MissingResource,
  NamespaceResource,
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
 *   `agent`: any agent, on its own record, and no person: an invitation is the
 *   agent's to read, accept and leave, and nobody answers it in its place;
 *   `account`: any user or agent; `user`: any user; `handle`: any user, even
 *   one without a handle yet;
 * - `read`: reads the resource (public projects to anyone, private ones to their
 *   org's members, an agent's account to anyone as the public); `readMembers`:
 *   reads what only members see; `readMembersOrSponsor`: that, or, in an
 *   agent's own namespace, what is asked of the sponsor of the agent concerned;
 * - `work`: an agent's work on its token's project (agents only);
 *   `workOrMaintain`: that, or a maintainer's;
 * - `member`, `maintain`, `own`: that role or above in the resource's org, or
 *   an agent where it governs and no person owns; `sponsorOrMaintain`: the
 *   sponsor of the agent concerned (a member, or anyone in the agent's own
 *   namespace, where no person holds a role), or whoever holds `maintain`;
 *   `sponsorOrMaintainAsUser`: that, and a person: a question Keel puts to
 *   people is answered by one, so no agent rules, whatever it maintains;
 *   `invite`: a member, and a person: an invitation names the person who
 *   answers for the agent, so no agent makes one, wherever it governs;
 *   `inviterOrMaintain`: the member who invited the agent concerned into the
 *   org, or whoever holds `maintain` there, and a person too; `ownAsUser`:
 *   an owner, and a person: an org's credentials and a project's deploy
 *   targets are never an agent's, wherever it governs;
 * - `sponsor`: the person who sponsors the agent the action is on, and
 *   nobody else, whatever their role anywhere; `sponsorOrSelf`: that person, or
 *   the agent itself.
 */
export type Need =
  | "anyone"
  | "self"
  | "agent"
  | "account"
  | "user"
  | "handle"
  | "read"
  | "readMembers"
  | "readMembersOrSponsor"
  | "work"
  | "workOrMaintain"
  | "member"
  | "invite"
  | "sponsorOrMaintain"
  | "sponsorOrMaintainAsUser"
  | "inviterOrMaintain"
  | "maintain"
  | "own"
  | "ownAsUser"
  | "sponsor"
  | "sponsorOrSelf";

/**
 * The kind of resource an action is decided on. `Org` is a namespace asked for
 * what only an org has: its members, its owners, its deletion.
 * `PersonalProject` is a project asked for what only a person's own namespace
 * gives it: an agent invited to that one project (an org takes an agent whole).
 */
export type ResourceKind =
  | "Instance"
  | "Self"
  | "Namespace"
  | "Org"
  | "Project"
  | "PersonalProject"
  | "Agent"
  | "Fork";

export interface ActionRule {
  readonly resource: ResourceKind;
  readonly need: Need;
}

const rule = <K extends ResourceKind, N extends Need>(resource: K, need: N) => ({ resource, need });

/** Every operation in the spec (`packages/contracts/openapi.json`), by its operationId. */
export const SPEC_ACTIONS = {
  Auth_exchangeToken: rule("Instance", "anyone"),
  Auth_registerClient: rule("Instance", "anyone"),
  Lattices_listLattices: rule("Instance", "anyone"),
  SignIn_methods: rule("Instance", "anyone"),
  whoami: rule("Self", "self"),
  inbox: rule("Self", "self"),
  askSponsor: rule("Self", "self"),
  Users_me: rule("Self", "user"),
  // Approving is the person's own act: the code the agent showed them is what lets them, and
  // nothing about the agent is decided or told before the code is checked.
  Agents_approveSponsor: rule("Self", "user"),
  Agents_listSponsored: rule("Self", "user"),
  Users_listSponsorRequests: rule("Self", "user"),
  Users_approveSponsorRequest: rule("Self", "user"),
  Users_declineSponsorRequest: rule("Self", "user"),
  Users_listBlockedAgents: rule("Self", "user"),
  Users_unblockAgent: rule("Self", "user"),

  Operator_listProjects: rule("Namespace", "read"),
  Operator_createProject: rule("Namespace", "member"),
  Namespaces_getNamespace: rule("Namespace", "read"),
  Namespaces_getProject: rule("Project", "read"),
  Namespaces_listAgents: rule("Namespace", "read"),
  // An agent is invited into an org, never into a person's own namespace, and by a person.
  Namespaces_inviteAgent: rule("Org", "invite"),
  Namespaces_removeAgent: rule("Org", "inviterOrMaintain"),
  // In a person's own namespace an agent is invited to one project, never to the whole of it.
  Projects_inviteAgent: rule("PersonalProject", "own"),
  Projects_listAgents: rule("Project", "read"),
  Projects_removeAgent: rule("PersonalProject", "own"),

  Changes_listChanges: rule("Project", "read"),
  change: rule("Project", "read"),
  diff: rule("Project", "read"),
  status: rule("Project", "read"),
  nearby: rule("Project", "read"),
  why: rule("Project", "read"),
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
  Repo_compare: rule("Project", "read"),
  Repo_getTree: rule("Project", "read"),
  Agents_getAgent: rule("Agent", "read"),

  Operator_getSettings: rule("Project", "readMembers"),
  Operator_listEscalations: rule("Project", "readMembersOrSponsor"),

  declare: rule("Project", "work"),
  adopt: rule("Project", "work"),
  rely: rule("Project", "work"),
  rebase: rule("Project", "work"),
  commit: rule("Project", "work"),
  revise: rule("Project", "work"),
  submit: rule("Project", "work"),
  resolve: rule("Project", "work"),
  Sessions_openSession: rule("Project", "work"),
  refreshWorkspaceToken: rule("Project", "work"),
  abandon: rule("Project", "workOrMaintain"),

  Operator_enrolAgent: rule("Project", "member"),
  Operator_giveRuling: rule("Project", "sponsorOrMaintainAsUser"),
  Operator_revokeAgent: rule("Project", "sponsorOrMaintain"),
  // Pausing is the sponsor's alone: a maintainer removes an agent from its org instead.
  Operator_suspendAgent: rule("Agent", "sponsor"),
  Operator_reinstateAgent: rule("Agent", "sponsor"),
  Agents_endSponsorship: rule("Agent", "sponsorOrSelf"),
  Agents_listNamespaces: rule("Self", "agent"),
  Agents_acceptInvitation: rule("Self", "agent"),
  Agents_leaveNamespace: rule("Self", "agent"),
  Agents_listProjects: rule("Self", "agent"),
  Agents_listReachableProjects: rule("Self", "agent"),
  Agents_acceptProjectInvitation: rule("Self", "agent"),
  Agents_leaveProject: rule("Self", "agent"),
  Operator_putSettings: rule("Project", "maintain"),
  // Moving trunk to commits Keel did not verify is its owners' call alone.
  Operator_syncUpstream: rule("Project", "own"),

  // A namespace's credentials and a project's deploy targets are its owners' alone.
  Delivery_createCredential: rule("Namespace", "ownAsUser"),
  Delivery_listCredentials: rule("Namespace", "ownAsUser"),
  Delivery_deleteCredential: rule("Namespace", "ownAsUser"),
  Delivery_putDeployTarget: rule("Project", "ownAsUser"),
  Delivery_listDeployTargets: rule("Project", "ownAsUser"),
  Delivery_deleteDeployTarget: rule("Project", "ownAsUser"),
  Delivery_beginCloudflareConnect: rule("Project", "ownAsUser"),
  Delivery_completeCloudflareConnect: rule("Project", "ownAsUser"),
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
  DeleteProject: rule("Project", "own"),
  CloneRepo: rule("Project", "read"),
  /** Granted when the caller reads the source and is a member of the target org. */
  Operator_forkProject: rule("Fork", "member"),
} as const satisfies Record<string, ActionRule>;

export const ACTIONS = { ...SPEC_ACTIONS, ...NON_SPEC_ACTIONS } as const;
export type Action = keyof typeof ACTIONS;
export type SpecAction = keyof typeof SPEC_ACTIONS;

/**
 * The resources an action of each kind is decided on. A project or a namespace
 * may be missing, and an `Org` action is asked of whatever namespace was named:
 * one that is no org is answered as missing. So is a `PersonalProject` action
 * asked of a project that is not in a person's own namespace.
 */
interface ResourceOfKind {
  readonly Instance: InstanceResource;
  readonly Self: SelfResource;
  readonly Namespace: NamespaceResource | MissingResource;
  readonly Org: NamespaceResource | MissingResource;
  readonly Project: ProjectResource | MissingResource;
  readonly PersonalProject: ProjectResource | MissingResource;
  readonly Agent: AgentResource | MissingResource;
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

/** A namespace's kind, read from its id: the one place the policy learns it. */
const kindOf = (resource: NamespaceResource | ProjectResource): NamespaceKind =>
  namespaceKind(resource.namespace);

const roleIn = (memberships: readonly Membership[], org: NamespaceId): Role | undefined =>
  memberships.find((m) => m.org === org)?.role;

/**
 * A user's role in a namespace: `owner` of the one whose id is its own, by
 * identity and by no membership, so it holds whatever the gate filled; in an
 * org, the role its membership names; in anyone else's own namespace none,
 * whatever a membership says, since only an org has members.
 */
export const roleOf = (user: UserPrincipal, namespace: NamespaceId): Role | undefined => {
  if (namespace === user.userId) return "owner";
  return namespaceKind(namespace) === "org" ? roleIn(user.memberships, namespace) : undefined;
};

/**
 * Whom a list of projects is narrowed for before the policy decides each: the
 * namespaces the caller may hold a role in, and the one project an agent's
 * token is for. What is public is shown to every audience.
 */
export interface ProjectAudience {
  readonly namespaces: readonly NamespaceId[];
  readonly project?: ProjectId;
}

const NO_AUDIENCE: ProjectAudience = { namespaces: [] };

/**
 * The audience a principal's list of projects is read for: a person's own
 * namespace and their orgs, an agent's token project, nothing for a visitor.
 * It narrows what is read and grants nothing: `authorize` decides every project
 * read, so it must never leave out one the policy would grant.
 */
export const projectAudience = (principal: Principal): ProjectAudience => {
  switch (principal._tag) {
    case "User":
      return { namespaces: [principal.userId, ...principal.memberships.map((m) => m.org)] };
    case "Agent":
      return principal.projectId === undefined
        ? NO_AUDIENCE
        : { namespaces: [], project: principal.projectId };
    case "Anonymous":
      return NO_AUDIENCE;
    default: {
      const unreachable: never = principal;
      return unreachable;
    }
  }
};

/** Rights from a role in the resource's namespace, else a public read. */
const rightsByRole = (role: Role | undefined, resource: Resource): ReadonlySet<Right> => {
  switch (resource._tag) {
    case "Project":
      if (resource.namespaceSuspended) return NONE;
      if (role !== undefined) return new Set(ROLE_RIGHTS[role]);
      return resource.visibility === "public" ? READ : NONE;
    case "Namespace":
      if (resource.suspended) return NONE;
      return role === undefined ? READ : new Set(ROLE_RIGHTS[role]);
    case "Agent":
      return READ;
    default:
      return NONE;
  }
};

const namespaceOf = (resource: Resource): NamespaceId | undefined =>
  resource._tag === "Project" || resource._tag === "Namespace" ? resource.namespace : undefined;

/** Whether the resource is the project the agent's token is for. A token that names none is for no project. */
const isTokenProject = (agent: AgentPrincipal, resource: Resource): boolean =>
  resource._tag === "Project" &&
  resource.namespace === agent.namespace &&
  resource.projectId === agent.projectId;

/** Whether whoever invited an agent still answers for it: holding a role in the namespace, not suspended. */
export const answers = (by: MemberStanding): boolean => by.role !== undefined && !by.suspended;

/**
 * The standing an agent brings to a resource. A token is for at most one
 * project, so its standing in the namespace counts on that project and on the
 * namespace itself, never on another of its projects. Everywhere else, and once
 * its inviter no longer answers for it, the agent is the public.
 */
const standingOn = (
  agent: AgentPrincipal,
  resource: ProjectResource | NamespaceResource,
): AgentStanding["_tag"] => {
  const { standing } = agent;
  if (resource.namespace !== agent.namespace) return "None";
  if (resource._tag === "Project" && resource.projectId !== agent.projectId) return "None";
  return standing._tag === "Invited" && !answers(standing.by) ? "None" : standing._tag;
};

/**
 * Whether an agent's `Governs` counts in the resource's namespace: in an org,
 * and in the agent's own namespace. Never in a person's own, nor in another
 * agent's, whatever the standing says.
 */
const mayGovern = (agent: AgentPrincipal, resource: ProjectResource | NamespaceResource): boolean =>
  kindOf(resource) === "org" || resource.namespace === agent.agentId;

/** The rights of whoever governs. Where a person owns, they are people's alone. */
const GOVERNING: readonly Right[] = ["member", "maintain", "own"];

/**
 * An agent's rights, by where it stands: everything where it
 * governs, `read` and `work` on its token's project where a member invited it,
 * and a read of what is public anywhere else. A paused agent has none. Its
 * scopes cap `read` and `work`; `operator` and `observer` confer nothing.
 *
 * Governing is by the namespace's kind (`mayGovern`): it counts in an org, and
 * in an agent's own namespace for that agent alone. And no agent governs where
 * a person owns: on such a resource `member`, `maintain` and `own` are taken
 * out last, whatever the standing says, so the rule does not rest on the gate
 * having filled the standing truthfully.
 */
const agentRights = (agent: AgentPrincipal, resource: Resource): ReadonlySet<Right> => {
  if (agent.paused) return NONE;
  if (resource._tag === "Agent") return agent.scopes.includes("agent:read") ? READ : NONE;
  if (resource._tag !== "Project" && resource._tag !== "Namespace") return NONE;
  if (resource._tag === "Namespace" ? resource.suspended : resource.namespaceSuspended) return NONE;
  const standing = standingOn(agent, resource);
  const rights = new Set<Right>();
  if (resource._tag === "Namespace" || resource.visibility === "public") rights.add("read");
  if (standing !== "None") rights.add("read");
  if (standing !== "None" && resource._tag === "Project") rights.add("work");
  if (standing === "Governs" && mayGovern(agent, resource))
    for (const right of GOVERNING) rights.add(right);
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
      const namespace = namespaceOf(resource);
      return rightsByRole(
        namespace === undefined ? undefined : roleOf(principal, namespace),
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

/** An agent needs nothing but a key to have an account: the discovery document the 401's challenge leads to says where. */
const SIGN_UP: NextAction = {
  kind: "call",
  title:
    "An agent with no account signs up with a key it holds, then asks for tokens with requests that key signs",
  operationId: "Auth_registerClient",
};

/** The page at the instance's own address that walks an agent from a key to a token: no operation, so it is named in words. */
export const READ_START: NextAction = {
  kind: "read",
  title:
    "Read /start at this address: every step from a key to a token and a first change, each request spelled out",
};

/** What a caller with no good credential is told: an agent signs up with a key, and the walk says the rest. */
export const ARRIVE: readonly NextAction[] = [SIGN_UP, READ_START];

const unauthenticated = (): Decision =>
  Result.fail(new AuthenticationRequired({ nextActions: [...ARRIVE] }));

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
    title: "You are paused; ask your sponsor to reinstate you",
  },
  "inviter-suspended": {
    kind: "escalate",
    title:
      "Whoever answers for you in this namespace is suspended; ask another who holds a role there to invite you",
  },
  "inviter-left": {
    kind: "escalate",
    title:
      "Whoever answered for you in this namespace holds no role there now; ask someone who does to invite you",
  },
  "org-suspended": {
    kind: "escalate",
    title: "This namespace is suspended; ask whoever runs this Keel to reinstate it",
  },
  "foreign-project": {
    kind: "escalate",
    title:
      "Your token is for another project, or you have no standing in this one; use a token for it, or ask whoever holds a role in its namespace to invite you",
  },
  scope: {
    kind: "call",
    title: "Exchange your credentials for a token with the scope this needs",
    operationId: "Auth_exchangeToken",
  },
  "private-source": {
    kind: "escalate",
    title:
      "A private project forks only into its own namespace; ask whoever maintains it to make it public",
  },
};

const refused = (reason: Exclude<RefusalReason, "role">): Decision =>
  Result.fail(new AccessRefused({ reason, nextActions: [NEXT[reason]] }));

const ROLE_NAMES: Readonly<Record<"member" | "maintain" | "own", string>> = {
  member: "a member",
  maintain: "a maintainer or an owner",
  own: "an owner",
};

/** A person's or an agent's own namespace has nobody to ask: only its owner does what needs a role there. */
const OWN_NAMESPACE: Readonly<Record<Exclude<NamespaceKind, "org">, string>> = {
  user: "a person's own",
  agent: "an agent's own",
};

/** The refusal of a role the caller lacks, worded by the namespace's kind: only an org has members to ask. */
const lacksRole = (need: "member" | "maintain" | "own", kind: NamespaceKind): Decision =>
  Result.fail(
    new AccessRefused({
      reason: "role",
      nextActions: [
        {
          kind: "escalate",
          title:
            kind === "org"
              ? `Ask ${ROLE_NAMES[need]}: this needs that role`
              : `This is ${OWN_NAMESPACE[kind]} namespace and has no members: only its owner does this. Use your own namespace, or an org you are a member of`,
        },
      ],
    }),
  );

/**
 * Whether someone with a role in the resource's namespace is asking. An agent
 * counts as inside the namespace of its token's project while it has a standing
 * there, also one whose inviter no longer answers for it: it is told why it is
 * refused. An agent invited to one project alone is inside on that project and
 * nowhere else: another private project of the namespace is not there for it.
 */
const inside = (
  principal: UserPrincipal | AgentPrincipal,
  resource: ProjectResource | NamespaceResource,
): boolean => {
  if (principal._tag === "User") return roleOf(principal, resource.namespace) !== undefined;
  const { standing } = principal;
  if (principal.namespace !== resource.namespace || standing._tag === "None") return false;
  const oneProject = standing._tag === "Invited" && standing.projectOnly === true;
  return !oneProject || isTokenProject(principal, resource);
};

/**
 * Whether the resource is there for this caller to be refused: a private or
 * missing project, or anything of a suspended namespace, is NotVisible to
 * outsiders, so they cannot tell it from one that does not exist. Insiders of a
 * suspended namespace are told it is suspended.
 */
const notSeen = (
  principal: UserPrincipal | AgentPrincipal,
  resource: ProjectResource | NamespaceResource | MissingResource,
): Decision | undefined => {
  if (resource._tag === "Missing") return hidden();
  const within = inside(principal, resource);
  const suspended =
    resource._tag === "Namespace" ? resource.suspended : resource.namespaceSuspended;
  if (suspended) return within ? refused("org-suspended") : hidden();
  if (resource._tag === "Project" && resource.visibility === "private" && !within) return hidden();
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
  if (!rightsOf(user, resource.target).has("member"))
    return lacksRole("member", kindOf(resource.target));
  const { source: project } = resource;
  if (
    project._tag === "Project" &&
    project.visibility === "private" &&
    project.namespace !== resource.target.namespace
  )
    return refused("private-source");
  return granted();
};

/** Whether the person is the sponsor of the agent concerned, on a project of an agent's own namespace. */
const asksSponsor = (
  principal: UserPrincipal,
  resource: ProjectResource | NamespaceResource,
): resource is ProjectResource =>
  resource._tag === "Project" &&
  resource.sponsor === principal.userId &&
  namespaceKind(resource.namespace) === "agent";

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
    // Work is an agent's, and so is the answer to an invitation: no person gives it in the agent's place.
    case "work":
    case "agent":
      return refused("agents-only");
    // An agent's account is there only for the person who sponsors it.
    case "sponsor":
    case "sponsorOrSelf":
      return resource._tag === "Agent" && resource.sponsor === principal.userId
        ? granted()
        : hidden();
    default:
      break;
  }
  if (resource._tag === "Fork") return fork(principal, resource);
  // An agent that exists is there for anyone to read, as the public: who it is, never who sponsors it.
  if (resource._tag === "Agent") return need === "read" ? granted("public") : hidden();
  if (resource._tag !== "Project" && resource._tag !== "Namespace") return hidden();
  // In an agent's own namespace no person holds a role, and Keel asks the agent's sponsor first: the sponsor
  // sees what it is asked and answers it, private project or not, and nothing else there.
  if (
    (need === "sponsorOrMaintain" ||
      need === "sponsorOrMaintainAsUser" ||
      need === "readMembersOrSponsor") &&
    asksSponsor(principal, resource)
  )
    return resource.namespaceSuspended
      ? hidden()
      : granted(need === "readMembersOrSponsor" ? "members" : undefined);
  const unseen = notSeen(principal, resource);
  if (unseen !== undefined) return unseen;
  const rights = rightsOf(principal, resource);
  const kind = kindOf(resource);
  switch (need) {
    case "read":
      return granted(rights.has("member") ? "members" : "public");
    case "readMembers":
    case "readMembersOrSponsor":
      return rights.has("member") ? granted("members") : lacksRole("member", kind);
    case "member":
    case "invite":
      return rights.has("member") ? granted() : lacksRole("member", kind);
    case "maintain":
    case "workOrMaintain":
      return rights.has("maintain") ? granted() : lacksRole("maintain", kind);
    case "own":
    case "ownAsUser":
      return rights.has("own") ? granted() : lacksRole("own", kind);
    case "sponsorOrMaintain":
    case "sponsorOrMaintainAsUser":
      return rights.has("maintain") ||
        (rights.has("member") &&
          resource._tag === "Project" &&
          resource.sponsor === principal.userId)
        ? granted()
        : lacksRole("maintain", kind);
    // The member who invited an agent may take it out again; so may whoever maintains the org.
    case "inviterOrMaintain":
      return rights.has("maintain") ||
        (rights.has("member") &&
          resource._tag === "Namespace" &&
          resource.inviter === principal.userId)
        ? granted()
        : lacksRole("maintain", kind);
    default:
      return hidden();
  }
};

/** Why an agent may not read or work on what it sees. */
const whyNoWork = (
  agent: AgentPrincipal,
  resource: ProjectResource | NamespaceResource,
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
  resource: ProjectResource | NamespaceResource,
): Exclude<RefusalReason, "role"> =>
  agent.standing._tag === "Governs" &&
  resource.namespace === agent.namespace &&
  !resource.personOwned &&
  mayGovern(agent, resource)
    ? "foreign-project"
    : "users-only";

const agent = (principal: AgentPrincipal, need: Need, resource: Resource): Decision => {
  if (principal.paused) return refused("agent-paused");
  switch (need) {
    case "anyone":
    case "self":
    case "agent":
    case "account":
      return granted();
    case "user":
    case "handle":
      return refused("users-only");
    // Its own account is there for it, and no other agent's: it may leave its sponsor, and only a person pauses.
    case "sponsor":
    case "sponsorOrSelf":
      if (resource._tag !== "Agent" || resource.agentId !== principal.agentId) return hidden();
      return need === "sponsorOrSelf" ? granted() : refused("users-only");
    default:
      break;
  }
  if (resource._tag === "Fork") return refused("users-only");
  if (resource._tag === "Agent") {
    if (need !== "read") return hidden();
    return rightsOf(principal, resource).has("read") ? granted("public") : refused("scope");
  }
  if (resource._tag !== "Project" && resource._tag !== "Namespace") return hidden();
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
        resource._tag === "Namespace" || resource.visibility === "public"
          ? "scope"
          : whyNoWork(principal, resource),
      );
    case "readMembers":
    case "readMembersOrSponsor":
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
    // An invitation names the person who answers for the agent: no agent makes or ends one for
    // another, wherever it governs. Its own invitation it ends as itself, by another action.
    case "invite":
    case "inviterOrMaintain":
    case "ownAsUser":
    case "sponsorOrMaintainAsUser":
      return refused("users-only");
    default:
      return hidden();
  }
};

/**
 * Whether an org's own action is asked of a namespace that is no org, where it
 * is asked of nothing: a person's or an agent's own namespace has no members,
 * and goes only with its account.
 */
const noOrg = (asked: ResourceKind, resource: Resource): boolean =>
  asked === "Org" && resource._tag === "Namespace" && kindOf(resource) !== "org";

/**
 * Whether an action of a person's own project is asked of a project somewhere
 * else, where it is asked of nothing: an org takes an agent into the whole of
 * it, and an agent's own namespace takes none.
 */
const notPersonal = (asked: ResourceKind, resource: Resource): boolean =>
  asked === "PersonalProject" && resource._tag === "Project" && kindOf(resource) !== "user";

/**
 * The one authorization policy: whether `principal` may take `action` on
 * `resource`. It decides from its arguments alone;
 * the gate fills them from the request and the Memberships port, and never
 * from events.
 *
 * - 401 `AuthenticationRequired`: an anonymous caller asking for anything but a
 *   public read.
 * - 404 `NotVisible`: a private project of a namespace the caller has no role
 *   in, a missing one, or anything of a suspended namespace to an outsider. It carries no
 *   fields: the gate answers the operation's own not-found, so a private
 *   resource and a missing one read the same.
 * - 403 `AccessRefused`: the caller sees the resource but may not do this, with
 *   a reason and next actions. A private project of the agent's namespace that
 *   its token is not for is `foreign-project`; one in another is NotVisible.
 *
 * A person owns the namespace whose id is their own, by identity, and nobody
 * else holds a role there: a membership counts in an org alone. Inviting,
 * removing, making an owner and deleting are an org's own actions: of a
 * person's or an agent's own namespace they are NotVisible. Inviting an agent
 * to one project is a person's own project's: of a project anywhere else it is
 * NotVisible, and it is a person's act, never an agent's. Whoever lacks a
 * role is told whom to ask in an org, and in anyone's own namespace that there
 * is nobody to ask.
 *
 * Work is agents' only. Governance is people's wherever a person owns: an agent
 * governs only its own namespace, or an org it created that no person owns, and
 * an agent a member invited works and never governs. A sponsor gives an agent
 * no rights. No principal stands above an org's owners: there is no instance
 * role.
 *
 * An agent's own account belongs to no org. Anyone reads it, as the public.
 * What is decided on it (pausing it, ending its sponsor's link) is its
 * sponsor's, and the link's end the agent's own too; to everyone else, a
 * maintainer of an org it works in among them, such a move is NotVisible. A
 * paused agent is refused before that, so it cannot leave the sponsor who
 * paused it.
 */
export const authorize = <A extends Action>(
  principal: Principal,
  action: A,
  resource: ResourceFor<A>,
): Decision => {
  const { need, resource: asked } = ACTIONS[action];
  const on: Resource =
    noOrg(asked, resource) || notPersonal(asked, resource) ? { _tag: "Missing" } : resource;
  switch (principal._tag) {
    case "Anonymous":
      return anonymous(need, on);
    case "User":
      return user(principal, need, on);
    case "Agent":
      return agent(principal, need, on);
    default: {
      const unreachable: never = principal;
      return unreachable;
    }
  }
};
