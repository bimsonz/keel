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

  /** The agent's open session, if it has one. */
  session: SessionRef | null;
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
}

/** The agents a person stands behind. */
model SponsoredAgents {
  items: AgentProfile[];
}

@tag("Agents")
@route("/agents")
interface Agents {
  /** Who the presented token belongs to, its scopes, and its open session. Call it first. */
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
