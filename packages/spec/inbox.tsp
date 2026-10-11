import "@typespec/http";
import "@typespec/openapi";
import "./common.tsp";
import "./events.tsp";
import "./changes.tsp";

using Http;
using OpenAPI;

namespace Keel;

model InboxPage {
  notices: Notice[];

  /** Pass back as `cursor` to read only what is newer. */
  cursor: string;
}

model InboxEnvelope is AgentEnvelope<InboxPage>;

/** The principal whose command caused an event: `agent:<agent id>` or `operator:<by>`. */
@pattern("^(agent:agt_[0-9A-HJKMNP-TV-Z]{26}|operator:.+)$")
scalar EventActor extends string;

/**
 * A short label for the entity an event created, numbered per project and kind:
 * `D-n` decisions, `G-n` guards, `C-n` conflicts, `E-n` escalations, `P-n`
 * probes, and `#n` changes.
 */
@pattern("^([DGCEP]-[1-9][0-9]*|#[1-9][0-9]*)$")
scalar EventLabel extends string;

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

  /** Who caused the event. Absent when the platform did: Precheck, alarms, reactions, a landing. */
  actor?: EventActor;

  /** The project the event belongs to. */
  project?: ProjectId;

  /** Set on the event that created a labelled entity, by the Projector when it first records it. */
  label?: EventLabel;

  /** The event itself; `type` is its `_tag`. */
  payload: KeelEvent;
}

model EventPage {
  items: EventRecord[];

  /**
   * The cursor just after the last item returned. Always present, even on the
   * last page: pass it back as `cursor` to read only what is newer.
   */
  nextCursor: string;
}

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

  /**
   * A project's changes and trunk at the head of the operation log, with the cursor they were taken at:
   * `listEvents` from that cursor returns exactly what the snapshot does not hold, so a console folds
   * forward from it. Head only. Scoped as `listChanges`.
   */
  @summary("Snapshot at the head")
  @useAuth(Observer | AgentRead)
  @route("/events/snapshot")
  @get
  getSnapshot(@query project?: ProjectId): FeedSnapshot | StandardErrors;
}

/** Trunk's head commit and height: 0 at initialization, one more per advance. */
model TrunkHead {
  head: CommitSha;
  height: int32;
}

/** A project's state at the head of the operation log, and the cursor it was taken at. */
model FeedSnapshot {
  /** Read `GET /v1/events?cursor=` from here to fold forward. */
  cursor: string;

  /** Every change of the project, newest `#n` first. */
  changes: ChangeSummary[];

  /** Absent until the project's trunk is initialized. */
  trunk?: TrunkHead;
}
