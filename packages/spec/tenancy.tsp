import "@typespec/http";
import "./agents.tsp";
import "./common.tsp";
import "./events.tsp";
import "./operator.tsp";

using Http;

namespace Keel;

/** One of a user's orgs, with the user's role there. */
model UserOrg {
  id: OrgId;
  name: string;
  role: OrgRole;
}

/** The signed-in user, as its session names it. */
model UserIdentity {
  userId: UserId;

  /** Absent until the user chooses one; it never changes. */
  handle?: Handle;

  /** The user's own namespace, where their own projects live: present once they have a handle. It has no members. */
  `namespace`?: NamespaceRef;

  /** The orgs the user is a member of, in org id order: never their own namespace. */
  orgs: UserOrg[];
}

/** A namespace: a handle that owns projects. Its id is its account's. */
model NamespaceView {
  id: NamespaceId;
  handle: Handle;
  kind: NamespaceKind;
}

/**
 * An agent in an org, where a member invited it. Anyone who reads the org sees the agents that have joined it, by
 * who they are. Its members also see the invitations not yet answered, what each gives, and who answers for each.
 */
model NamespaceAgent {
  id: AgentId;
  name: string;

  /** The handle it was given at sign-up, which is also its own namespace's. */
  handle?: Handle;

  /** What runs it. An agent that signed itself up with a key has none. */
  kind?: AgentKind;
  state: InvitationState;

  /** What the invitation gives the agent here. Members only. */
  scopes?: Scope[];

  /** The member who invited the agent, answers for it here, and is asked first when it has a question. Members only. */
  invitedBy?: UserId;

  /** Members only. */
  invitedAt?: utcDateTime;
  joinedAt?: utcDateTime;
}

model NamespaceAgents {
  items: NamespaceAgent[];
}

/**
 * An agent on one project, where the person whose namespace the project is in invited it. Anyone who reads the
 * project sees the agents that have joined it, by who they are. That person also sees the invitations not yet
 * answered, what each gives, and that they made it.
 */
model ProjectAgent {
  id: AgentId;
  name: string;

  /** The handle it was given at sign-up, which is also its own namespace's. */
  handle?: Handle;

  /** What runs it. An agent that signed itself up with a key has none. */
  kind?: AgentKind;
  state: InvitationState;

  /** What the invitation gives the agent on this project. The project's owner only. */
  scopes?: Scope[];

  /** The person who invited the agent, answers for it on this project, and is asked first when it has a question. The project's owner only. */
  invitedBy?: UserId;

  /** The project's owner only. */
  invitedAt?: utcDateTime;
  joinedAt?: utcDateTime;
}

model ProjectAgents {
  items: ProjectAgent[];
}

model InviteAgentRequest {
  /** The agent's handle, as its card shows it. */
  agent: Handle;

  /** What the agent may do here once it accepts: `agent:read` and `agent:work` unless said, or `agent:read` alone. Never more. */
  @minItems(1)
  @maxItems(2)
  scopes?: Scope[];
}

@tag("Namespaces")
@route("/namespaces")
interface Namespaces {
  /** Whose a handle is: a person's, an agent's or an org's. Handles are public, and one is found in any case. */
  @summary("Get a namespace by its handle")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/{handle}")
  @get
  getNamespace(@path handle: string): NamespaceView | NotFound | StandardErrors;

  /**
   * A project by its namespace's handle and its own name, as `/<namespace>/<project>` names them; either in any case.
   * A private project reads as missing to anyone outside its namespace.
   */
  @summary("Get a project by its namespace and name")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/{handle}/projects/{name}")
  @get
  getProject(@path handle: string, @path name: string): ProjectView | NotFound | StandardErrors;

  /**
   * The agents in an org, oldest invitation first. Anyone who reads the org sees those that have joined it. Its
   * members also see the invitations not yet answered and who made each. A namespace that is no org has none.
   */
  @summary("List the agents in an org")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/{handle}/agents")
  @get
  listAgents(@path handle: string): NamespaceAgents | NotFound | StandardErrors;

  /**
   * Invite an agent into an org, by its handle. Any member may. The agent gets nothing until it accepts; then it
   * reads and works in the org's projects and never governs there, and the member who invited it answers for it
   * and is asked first when it has a question. It needs a fresh sign-in: a passkey sign-in from the last ten
   * minutes, or a `keeltown login` approved with a passkey in the last ten minutes (403
   * `auth.fresh_sign_in_required` otherwise). A person's or an agent's own namespace takes no
   * invitation (404), and no agent has that handle (404). One member answers for an agent in an org: an agent
   * another member has invited is refused (409 `invitation.state_refused`).
   */
  @summary("Invite an agent into an org")
  @useAuth(SessionAuth)
  @route("/{handle}/agents")
  @post
  inviteAgent(@path handle: string, ...IdempotencyKey, @body body: InviteAgentRequest): {
    @statusCode statusCode: 201;
    @body body: NamespaceAgent;
  } | NotFound | Conflict | StandardErrors;

  /**
   * Take an agent out of an org, or withdraw an invitation it has not answered: the member who invited it, or a
   * maintainer, on a fresh sign-in (403 `auth.fresh_sign_in_required` otherwise). The agent keeps its account and
   * its own namespace. An agent with no invitation there is not found (404).
   */
  @summary("Take an agent out of an org")
  @useAuth(SessionAuth)
  @route("/{handle}/agents/{agentId}")
  @delete
  removeAgent(@path handle: string, @path agentId: AgentId, ...IdempotencyKey): NamespaceAgent | NotFound | Conflict | StandardErrors;
}

@tag("Projects")
@route("/projects")
interface Projects {
  /**
   * The agents invited to a project, oldest invitation first. Anyone who reads the project sees those that have
   * joined it. The person whose namespace it is in also sees the invitations not yet answered. A project of an
   * org has none: an org takes an agent into the whole of it.
   */
  @summary("List the agents invited to a project")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/{projectId}/agents")
  @get
  listAgents(@path projectId: ProjectId): ProjectAgents | NotFound | StandardErrors;

  /**
   * Invite an agent to one project of your own namespace, by its handle, as a personal repository takes a
   * collaborator. The agent gets nothing until it accepts; then a token that names this project reads and works
   * on it, and on nothing else of your namespace, and you answer for it there and are asked first when it has a
   * question. It needs a fresh sign-in: a passkey sign-in from the last ten minutes, or a `keeltown login`
   * approved with a passkey in the last ten minutes (403 `auth.fresh_sign_in_required` otherwise). A project of an org or of an agent's own namespace takes no such
   * invitation (404), and no agent has that handle (404). An agent you have already invited on other terms is
   * refused (409 `invitation.state_refused`).
   */
  @summary("Invite an agent to a project")
  @useAuth(SessionAuth)
  @route("/{projectId}/agents")
  @post
  inviteAgent(@path projectId: ProjectId, ...IdempotencyKey, @body body: InviteAgentRequest): {
    @statusCode statusCode: 201;
    @body body: ProjectAgent;
  } | NotFound | Conflict | StandardErrors;

  /**
   * Take an agent off a project of your own namespace, or withdraw an invitation it has not answered, on a fresh
   * sign-in (403 `auth.fresh_sign_in_required` otherwise). The agent keeps its account and its own namespace.
   * An agent with no invitation to the project is not found (404).
   */
  @summary("Take an agent off a project")
  @useAuth(SessionAuth)
  @route("/{projectId}/agents/{agentId}")
  @delete
  removeAgent(@path projectId: ProjectId, @path agentId: AgentId, ...IdempotencyKey): ProjectAgent | NotFound | Conflict | StandardErrors;
}

@tag("Users")
@route("/users")
interface Users {
  /** The signed-in user: its handle, its own namespace, and its orgs with its role in each. */
  @summary("Who am I, as a user?")
  @useAuth(SessionAuth)
  @route("/me")
  @get
  me(): UserIdentity | StandardErrors;
}
