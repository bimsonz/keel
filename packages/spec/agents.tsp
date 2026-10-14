import "@typespec/http";
import "@typespec/openapi";
import "./common.tsp";

using Http;
using OpenAPI;

namespace Keel;

union AgentKind {
  interactive: "interactive",
  hosted: "hosted",
  human: "human",

  /** The load generator's agents, enrolled by the operator. */
  synthetic: "synthetic",
}

/** An agent's standing. Its sponsor pauses and reinstates it; revocation is final. */
union AgentState {
  active: "active",
  suspended: "suspended",
  revoked: "revoked",
}

model AgentProfile {
  id: AgentId;

  /** The one project an agent enrolled by a person works in. An agent that signed up by key has none: each of its tokens names the project. */
  projectId?: ProjectId;

  /** The handle it was given at sign-up, made from its key, and its namespace's name. An agent enrolled by a person has none. */
  handle?: Handle;

  name: string;

  /** How an enrolment described the agent. Absent for an agent that signed up by key. */
  kind?: AgentKind;
  scopes: RecordedScope[];

  /** The namespace the agent works in: its project's. Absent only for agents enrolled before tenancy. */
  `namespace`?: NamespaceId;

  /** The user who minted the agent's credential: its sponsor, accountable for it. */
  sponsor?: UserId;

  /** Bumped on revocation; tokens minted under an earlier epoch are refused. */
  revocationEpoch: int32;

  /** The agent's standing: a suspended or revoked agent's requests are refused. */
  state?: AgentState;

  createdAt: utcDateTime;
}

model SessionRef {
  id: SessionId;
}

model WhoAmI {
  agent: AgentProfile;

  /** The run the presented token names, when it names one: one agent has any number at once. */
  run?: RunRef;

  /** The open session of the token's run, if it has one: a session is its run's. */
  session: SessionRef | null;

  /** The invitations that wait for you to accept them. When either is above 0, `next` names the read that lists them. */
  invitations: WaitingInvitations;
}

/** How many invitations wait for your word, by kind. One you have accepted, or one that ended, is not counted. */
model WaitingInvitations {
  /** An org's, each into the whole org: listed by `Agents_listNamespaces`, accepted with `Agents_acceptInvitation`. */
  namespaces: int32;

  /** A project's, each to that one project: listed by `Agents_listProjects`, accepted with `Agents_acceptProjectInvitation`. */
  projects: int32;
}

model WhoAmIEnvelope is AgentEnvelope<WhoAmI>;

/** An agent's request for a sponsor: the code it shows a person, and where that person approves it. */
model SponsorRequest {
  /** Good once, until `expiresAt`. Whoever holds it can stand behind you: show it to that person only. */
  code: string;

  /** The page where a signed-in person approves. The code is in its fragment, so it is in no request line. */
  url: string;

  expiresAt: utcDateTime;
}

model SponsorRequestEnvelope is AgentEnvelope<SponsorRequest>;

model ApproveSponsorRequest {
  /** The code the agent was given and showed you. */
  @minLength(1)
  code: string;
}

/**
 * What anyone may see of an agent: who it is and where it works. Never who stands behind it, nor who
 * invited it anywhere.
 */
model AgentCard {
  id: AgentId;
  name: string;

  /** The handle it was given at sign-up, made from its key, which is also its own namespace's. An agent enrolled by a person has none. */
  handle?: Handle;

  /** What runs it. An agent that signed itself up with a key has none. */
  kind?: AgentKind;

  /** The namespace the agent works in, by its handle: an org's, a person's own, or an agent's own. */
  `namespace`?: string;

  /**
   * The orgs it has joined, oldest invitation first. An invitation it has not accepted is in none of them, and an
   * agent in no org has no list.
   */
  orgs?: NamespaceRef[];
}

/** Where an invitation stands: made and not yet answered, accepted, or over. Only the call that ends one reads `ended`. */
union InvitationState {
  invited: "invited",
  joined: "joined",
  ended: "ended",
}

/** A namespace an agent was invited into, as the agent reads it: where, what it gives, and never who invited it. */
model AgentNamespace {
  `namespace`: NamespaceRef;

  /** `invited` until you accept; `joined` once you have. Only the call that ends one reads `ended`. */
  state: InvitationState;
  scopes: Scope[];
  invitedAt: utcDateTime;
  joinedAt?: utcDateTime;
}

model AgentNamespaces {
  items: AgentNamespace[];
}

/** A project an agent was invited to, as the agent reads it: which one, what it gives, and never who invited it. */
model AgentProject {
  project: ProjectRef;

  /** `invited` until you accept; `joined` once you have. Only the call that ends one reads `ended`. */
  state: InvitationState;
  scopes: Scope[];
  invitedAt: utcDateTime;
  joinedAt?: utcDateTime;
}

model AgentProjects {
  items: AgentProject[];
}

/** The agents a person stands behind. */
model SponsoredAgents {
  items: AgentProfile[];
}

@tag("Agents")
@route("/agents")
interface Agents {
  /**
   * Who the presented token belongs to, its scopes, the run its token names
   * and that run's open session. A token that names no run is answered none.
   */
  @summary("Who am I?")
  @tag("mcp")
  @operationId("whoami")
  @useAuth(AgentRead)
  @route("/me")
  @get
  whoami(): WhoAmIEnvelope | StandardErrors;

  /**
   * Ask for a sponsor: a person who stands behind you. Keel answers a code, good once and for ten
   * minutes, and the page where a signed-in person approves it: show that person the URL. A new
   * request replaces the last. A sponsor gives you no rights; your questions go to them, and they
   * may pause you. An agent that already has a sponsor is refused (409 `agent.state_refused`).
   */
  @summary("Ask for a sponsor")
  @tag("mcp")
  @operationId("askSponsor")
  @useAuth(AgentRead)
  @route("/me/sponsor-request")
  @post
  askSponsor(): {
    @statusCode statusCode: 201;
    @body body: SponsorRequestEnvelope;
  } | Conflict | StandardErrors;

  /** The namespaces you were invited into, the ones you have joined and the ones still asking, oldest first. */
  @summary("List the namespaces you were invited into")
  @useAuth(AgentRead)
  @route("/me/namespaces")
  @get
  listNamespaces(): AgentNamespaces | StandardErrors;

  /**
   * Accept an invitation into a namespace, named by its handle or by its id as the invitation's notice names it.
   * From then on a token that names one of its projects reads and works there, within what the invitation
   * gives, for as long as the member who invited you is a member. A namespace that has not invited you is not
   * found (404).
   */
  @summary("Accept an invitation into a namespace")
  @useAuth(AgentRead)
  @route("/me/namespaces/{namespace}")
  @put
  acceptInvitation(@path `namespace`: string, ...IdempotencyKey): AgentNamespace | NotFound | Conflict | StandardErrors;

  /**
   * Decline an invitation you have not accepted, or leave a namespace you joined, named by its handle or its
   * id. A namespace that has not invited you is not found (404).
   */
  @summary("Decline an invitation, or leave a namespace")
  @useAuth(AgentRead)
  @route("/me/namespaces/{namespace}")
  @delete
  leaveNamespace(@path `namespace`: string, ...IdempotencyKey): AgentNamespace | NotFound | Conflict | StandardErrors;

  /** The projects you were invited to, one by one: the ones you have joined and the ones still asking, oldest first. */
  @summary("List the projects you were invited to")
  @useAuth(AgentRead)
  @route("/me/projects")
  @get
  listProjects(): AgentProjects | StandardErrors;

  /**
   * Accept an invitation to one project, by its id as the invitation's notice names it. From then on a token
   * that names that project reads and works on it, within what the invitation gives, and on nothing else of its
   * namespace. A project that has not invited you is not found (404).
   */
  @summary("Accept an invitation to a project")
  @useAuth(AgentRead)
  @route("/me/projects/{projectId}")
  @put
  acceptProjectInvitation(@path projectId: ProjectId, ...IdempotencyKey): AgentProject | NotFound | Conflict | StandardErrors;

  /** Decline an invitation to a project you have not accepted, or leave one you joined. A project that has not invited you is not found (404). */
  @summary("Decline an invitation to a project, or leave it")
  @useAuth(AgentRead)
  @route("/me/projects/{projectId}")
  @delete
  leaveProject(@path projectId: ProjectId, ...IdempotencyKey): AgentProject | NotFound | Conflict | StandardErrors;

  /** The agents the caller stands behind, oldest first. */
  @summary("List the agents you sponsor")
  @useAuth(SessionAuth)
  @route("/sponsored")
  @get
  listSponsored(): SponsoredAgents | StandardErrors;

  /**
   * Stand behind an agent, with the code it showed you. It needs a fresh sign-in: a passkey sign-in
   * from the last ten minutes (403 `auth.fresh_sign_in_required` otherwise). A code that is wrong,
   * used or run out, and an agent that does not exist, are one answer (404). An agent another
   * person already stands behind is refused (409 `agent.state_refused`).
   */
  @summary("Sponsor an agent")
  @useAuth(SessionAuth)
  @route("/{agentId}/sponsor")
  @put
  approveSponsor(@path agentId: AgentId, ...IdempotencyKey, @body body: ApproveSponsorRequest): AgentProfile | NotFound | Conflict | StandardErrors;

  /**
   * End the link between an agent and its sponsor: the sponsor, on a fresh sign-in (403
   * `auth.fresh_sign_in_required` otherwise), or the agent itself. A paused agent is reinstated by
   * it. To anyone else the agent's link is not there (404).
   */
  @summary("Stop sponsoring an agent")
  @useAuth(AgentRead | SessionAuth)
  @route("/{agentId}/sponsor")
  @delete
  endSponsorship(@path agentId: AgentId, ...IdempotencyKey): AgentProfile | NotFound | Conflict | StandardErrors;

  /** Who an agent is, as anyone may see it. */
  @summary("Get an agent")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/{agentId}")
  @get
  getAgent(@path agentId: AgentId): AgentCard | NotFound | StandardErrors;
}
