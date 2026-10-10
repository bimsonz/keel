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
}

model AgentProfile {
  id: AgentId;
  name: string;
  kind: AgentKind;
  scopes: Scope[];

  /** Bumped on revocation; tokens minted under an earlier epoch are refused. */
  revocationEpoch: int32;

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
