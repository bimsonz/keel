import { EventEnvelope } from "@keeltown/core/kernel";
import { Option, Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

/** What a receiver did with one delivery. */
export const DeliveryReceipt = Schema.Struct({
  /** New events it reacted to. */
  accepted: Schema.Int,
  /** Redeliveries of events it had already received: no-ops. */
  duplicates: Schema.Int,
  /** Events it does not know (a newer emitter's type or kind), recorded as received and otherwise left alone. */
  ignored: Schema.Int,
});
export type DeliveryReceipt = typeof DeliveryReceipt.Type;

export const EventCodecs = {
  receive: exitCodec(DeliveryReceipt, Schema.Never),
};

/**
 * How an envelope is read on arrival. Lenient, because the emitter may run a
 * different Worker version for minutes after a deploy: unknown fields are
 * dropped, `affected` and `notified` may be absent, and the entity kind is any
 * string. Only what dedupe needs is required.
 */
const ArrivingEnvelope = Schema.Struct({
  eventId: Schema.String,
  type: Schema.String,
  entity: Schema.Struct({ kind: Schema.String, id: Schema.String }),
  seq: Schema.Number,
  at: Schema.Number,
  dedupeKey: Schema.NonEmptyString,
  causation: Schema.optional(Schema.String),
  affected: Schema.optional(Schema.Array(Schema.Unknown)),
  notified: Schema.optional(Schema.Array(Schema.Unknown)),
  payload: Schema.Unknown,
});

/** One arrived event: its dedupe key, and the envelope if this version understands it. */
export interface Arrival {
  readonly dedupeKey: string;
  readonly envelope: EventEnvelope | undefined;
}

/**
 * Reads a delivery. An envelope without the fields dedupe needs is a defect
 * (the call fails, so the emitter keeps it owed and reports it). One this
 * version cannot fully read arrives without its envelope.
 */
export function readDelivery(delivery: unknown): readonly Arrival[] {
  return Schema.decodeUnknownSync(Schema.Array(ArrivingEnvelope))(delivery).map((arriving) => ({
    dedupeKey: arriving.dedupeKey,
    envelope: Option.getOrUndefined(
      Schema.decodeUnknownOption(EventEnvelope)({ ...arriving, affected: arriving.affected ?? [], notified: arriving.notified ?? [] }),
    ),
  }));
}

/** Every Keel Durable Object receives events through this one method. */
export interface EventReceiverRpc {
  receive(envelopes: unknown): Promise<ExitJson>;
}
