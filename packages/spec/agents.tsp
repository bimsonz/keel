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

/** An agent's standing. An operator suspends and reinstates; revocation is final. */
union AgentState {
  active: "active",
  suspended: "suspended",
  revoked: "revoked",
}

model AgentProfile {
  id: AgentId;

  /** The one project the agent is enrolled in. */
  projectId: ProjectId;

  name: string;
  kind: AgentKind;
  scopes: Scope[];

  /** The agent's sponsor, named at enrolment. */
  onBehalfOf?: Sponsor;

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

  /** The sponsor the presented token acts for. */
  onBehalfOf?: Sponsor;
}

model WhoAmIEnvelope is AgentEnvelope<WhoAmI>;

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
}
