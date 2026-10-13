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

  /** The user who sponsors the agent, from its enrolment: never named by the request. */
  sponsor?: UserId;

  /** The run that opened it, when its token named one. */
  run?: RunRef;

  openedAt: utcDateTime;
}

@tag("Sessions")
@route("/sessions")
interface Sessions {
  /**
   * Open a session: the record of the agent's working conversation, independent
   * of commits. It becomes the current session of the token's run, replacing that
   * run's other: another run's session stays.
   * A retry with the same Idempotency-Key and body answers the same session.
   */
  @summary("Open a session")
  @useAuth(AgentWork)
  @post
  openSession(
    ...IdempotencyKey,
    @body body: OpenSessionRequest,
  ): {
    @statusCode statusCode: 201;
    @body body: Session;
  } | NotFound | Conflict | StandardErrors;
}
