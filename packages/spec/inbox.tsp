import "@typespec/http";
import "@typespec/openapi";
import "./common.tsp";

using Http;
using OpenAPI;

namespace Keel;

model InboxPage {
  notices: Notice[];

  /** Pass back as `cursor` to read only what is newer. */
  cursor: string;
}

model InboxEnvelope is AgentEnvelope<InboxPage>;

/** One entry of the operation log, as published. */
model EventRecord {
  eventId: EventId;
  type: string;
  entity: {
    kind: string;
    id: string;
  };
  seq: int32;
  at: utcDateTime;
  payload: Record<unknown>;
}

model EventPage is Page<EventRecord>;

@tag("Inbox")
interface Inbox {
  /** Notices about what this agent relies on. `?wait` long-polls for harnesses that cannot hold a stream. */
  @summary("Read the inbox")
  @tag("mcp")
  @operationId("inbox")
  @useAuth(AgentRead)
  @route("/inbox")
  @get
  inbox(@query cursor?: string, ...WaitQuery): InboxEnvelope | StandardErrors;

  /** The operation log, oldest first from `cursor`. `?wait` long-polls for the next event. */
  @summary("Read events")
  @useAuth(Observer | AgentRead)
  @route("/events")
  @get
  listEvents(@query cursor?: string, ...WaitQuery, @query @minValue(1) @maxValue(500) limit?: int32): EventPage | StandardErrors;
}
