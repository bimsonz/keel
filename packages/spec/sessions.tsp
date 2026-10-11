import "@typespec/http";
import "./common.tsp";

using Http;

namespace Keel;

model OpenSessionRequest {
  /** The harness the agent runs in. */
  harness?: string;

  /** The model, pinned to a revision where the provider allows. */
  `model`?: string;

  /**
   * The human the agent acts for in this session. Optional: the session takes
   * the token's sponsor, else the enrolment's. Naming any other is refused
   * (`session.sponsor_refused`); an agent never names its own sponsor.
   */
  onBehalfOf?: Sponsor;
}

model Session {
  id: SessionId;
  agentId: AgentId;

  /** The human the agent acts for in this session: its token's sponsor, else its enrolment's. */
  onBehalfOf?: Sponsor;

  openedAt: utcDateTime;
}

@tag("Sessions")
@route("/sessions")
interface Sessions {
  /**
   * Open a session: the record of the agent's working conversation, independent
   * of commits. It becomes the agent's current session, replacing any other.
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
  } | Conflict | StandardErrors;
}
