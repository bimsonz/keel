import { FEED_END } from "@keeltown/core/application/memory";
import { CoordinationEvent } from "@keeltown/core/domain/coordination";
import { DeliveryEvent } from "@keeltown/core/domain/delivery";
import { IdentityEvent } from "@keeltown/core/domain/identity";
import { IntegrationEvent } from "@keeltown/core/domain/integration";
import { MemoryEvent } from "@keeltown/core/domain/memory";
import { VerificationEvent } from "@keeltown/core/domain/verification";
import { ProjectId } from "@keeltown/core/kernel";
import type { EventFeedEntry, EventFeedPage } from "@keeltown/core/ports";
import { Result, Schema } from "effect";
import type { Inbox_listEventsResult } from "../../../generated/http/app.gen.ts";
import type { ProblemBody } from "./problems.ts";
import type { Input } from "./work-loop.ts";

/**
 * Pure mappers for `GET /v1/events`: the Projector's feed entries as the
 * spec's EventRecord, and the page's cursor as `nextCursor` on every page
 *, the last and an empty one included.
 */

type Issues = NonNullable<ProblemBody["issues"]>;

/** Every event core commits. The spec's KeelEvent is held equal to it by `[events.conform]`. */
const KeelEvent = Schema.Union([
  CoordinationEvent,
  DeliveryEvent,
  IdentityEvent,
  IntegrationEvent,
  MemoryEvent,
  VerificationEvent,
]);
const decodeKeelEvent = Schema.decodeUnknownResult(KeelEvent);
const encodeKeelEvent = Schema.encodeSync(KeelEvent);

type EventPageBody = Extract<Inbox_listEventsResult, { readonly status: 200 }>["body"];
type WireEvent = EventPageBody["items"][number]["payload"];

/**
 * The feed holds each event as its committer encoded it. It is served as core
 * reads it now, decoded and encoded again: a key an older schema committed and
 * a later one retired is dropped, since the spec's objects are sealed. The
 * spec's KeelEvent is core's catalogue, held equal to it by `[events.conform]`;
 * they differ only in `| undefined` on optional keys, which JSON cannot carry.
 * `servedBody` parses the page against the spec again before it leaves.
 */
const isWireEvent = (payload: unknown): payload is WireEvent =>
  Result.isSuccess(decodeKeelEvent(payload));

/** A feed position: the Projector's twelve digits. */
const POSITION = /^\d{12}$/;

export interface EventsInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly waitSeconds?: number;
  readonly project?: ProjectId;
}

/** The query, with a cursor that is neither a feed position nor `end` refused as a 400 naming it. */
export function eventsInput(input: Input<"Inbox_listEvents">): Result.Result<EventsInput, Issues> {
  if (input.cursor !== undefined && input.cursor !== FEED_END && !POSITION.test(input.cursor)) {
    return Result.fail([
      {
        path: ["cursor"],
        message: "Expected a cursor from an earlier page (twelve digits), or `end` for the head",
      },
    ]);
  }
  return Result.succeed({
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.wait === undefined ? {} : { waitSeconds: input.wait }),
    ...(input.project === undefined ? {} : { project: ProjectId.make(input.project) }),
  });
}

/**
 * One entry as the spec's EventRecord. The feed holds what core committed, so
 * a payload core cannot read is a broken invariant (an event outside the
 * catalogue, or one changed in place), a defect rather than a silent skip.
 */
function eventRecord(entry: EventFeedEntry) {
  const decoded = decodeKeelEvent(entry.payload);
  if (Result.isFailure(decoded)) {
    throw new Error(`Feed event ${entry.eventId} (${entry.type}) is not in core's catalogue`);
  }
  const payload = JSON.parse(JSON.stringify(encodeKeelEvent(decoded.success)));
  if (!isWireEvent(payload)) {
    throw new Error(`Feed event ${entry.eventId} (${entry.type}) does not encode to its wire form`);
  }
  return {
    eventId: entry.eventId,
    type: payload._tag,
    entity: { kind: entry.entity.kind, id: entry.entity.id },
    seq: entry.seq,
    at: new Date(entry.at).toISOString(),
    ...(entry.actor === undefined ? {} : { actor: entry.actor }),
    ...(entry.run === undefined
      ? {}
      : {
          run: {
            id: entry.run.id,
            ...(entry.run.label === undefined ? {} : { label: entry.run.label }),
          },
        }),
    ...(entry.project === undefined ? {} : { project: entry.project }),
    ...(entry.label === undefined ? {} : { label: entry.label }),
    payload,
  };
}

export function eventsOk(page: EventFeedPage): Inbox_listEventsResult {
  return {
    status: 200,
    body: { items: page.events.map(eventRecord), nextCursor: page.cursor },
  };
}
