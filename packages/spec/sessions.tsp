import "@typespec/http";
import "./common.tsp";

using Http;

namespace Keel;

model OpenSessionRequest {
  /** The harness the agent runs in. */
  harness?: string;

  /** The model, pinned to a revision where the provider allows. */
  `model`?: string;
}

model Session {
  id: SessionId;
  agentId: AgentId;
  openedAt: utcDateTime;
}

@tag("Sessions")
@route("/sessions")
interface Sessions {
  /** Open a session: the record of the agent's working conversation, independent of commits. */
  @summary("Open a session")
  @useAuth(AgentWork)
  @post
  openSession(
    ...IdempotencyKey,
    @body body: OpenSessionRequest,
  ): {
    @statusCode statusCode: 201;
    @body body: Session;
  } | StandardErrors;
}
