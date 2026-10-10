import { type EntityRef, EventEnvelope, Instant, makeId } from "@keeltown/core/kernel";
import {
  type Backlog,
  Clock,
  DeliveryFailed,
  type DueDeliveries,
  EntityStore,
  envelopesFor,
  EVERY_TYPE,
  EventOutbox,
  type FanOut,
  type PriorCommit,
  type Stored,
  type Subscriber,
} from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import { makeEntityStoreMemory } from "./storage.ts";

const EVENT = "keel:event";
const SUBSCRIPTION = "keel:subscription";
const DELIVERY = "keel:delivery";
const DELIVERY_HEAD = { kind: "keel:delivery-head", id: "self" } as const;
const RECEIVED = "keel:received";

const StoredEvent = Schema.Struct({
  cause: Schema.String,
  fingerprint: Schema.NullOr(Schema.String),
  envelope: EventEnvelope,
});
const StoredDelivery = Schema.Struct({
  eventId: Schema.String,
  eventKey: Schema.String,
  subscriber: Schema.String,
  attempts: Schema.Int,
  nextAt: Schema.Number,
});
const StoredSubscription = Schema.Struct({ subscriber: Schema.String, type: Schema.String });

function isStored(value: unknown): value is Stored {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  )
    return true;
  if (Array.isArray(value)) return value.every(isStored);
  return typeof value === "object" && Object.values(value).every(isStored);
}

/** A schema value encoded for the store. Encoded values are JSON by construction; the guard holds it to that. */
function stored<S extends Schema.Codec<unknown, unknown>>(schema: S, value: S["Type"]): Stored {
  const encoded: unknown = Schema.encodeSync(schema)(value);
  if (!isStored(encoded)) throw new Error("an encoded value was not JSON");
  return encoded;
}

const pad = (n: number) => String(n).padStart(12, "0");
const entityKey = (entity: EntityRef) => `${entity.kind}:${entity.id}`;
const byId = (a: { readonly id: string }, b: { readonly id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulidOf(n: number): string {
  let out = "";
  let rest = n;
  for (let i = 0; i < 26; i += 1) {
    out = (CROCKFORD[rest % 32] ?? "0") + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/**
 * EventOutbox over any EntityStore: every row is an entity, so the store's
 * transaction covers the outbox exactly as DO SQLite's does. Events are kept
 * per entity in `seq` order; deliveries in commit order.
 */
function outboxOver(store: (typeof EntityStore)["Service"]): (typeof EventOutbox)["Service"] {
  let minted = 0;

  const eventsOf = (entity: EntityRef) =>
    store
      .list(EVENT)
      .filter((row) => row.id.startsWith(`${entityKey(entity)}#`))
      .toSorted(byId)
      .map((row) => Schema.decodeUnknownSync(StoredEvent)(row.value));

  const deliveries = () =>
    store
      .list(DELIVERY)
      .toSorted(byId)
      .map((row) => ({ id: row.id, ...Schema.decodeUnknownSync(StoredDelivery)(row.value) }));

  const subscribers = (type: string): readonly Subscriber[] =>
    [
      ...new Set(
        store
          .list(SUBSCRIPTION)
          .map((row) => Schema.decodeUnknownSync(StoredSubscription)(row.value))
          .filter((row) => row.type === type || row.type === EVERY_TYPE)
          .map((row) => row.subscriber),
      ),
    ].toSorted();

  const heads = () => {
    const seen = new Map<string, ReturnType<typeof deliveries>[number]>();
    for (const delivery of deliveries())
      if (!seen.has(delivery.subscriber)) seen.set(delivery.subscriber, delivery);
    return [...seen.values()];
  };

  return EventOutbox.of({
    append: (spec, at, drafts) => {
      const previous = eventsOf(spec.entity).at(-1)?.envelope.seq ?? 0;
      const envelopes = envelopesFor(
        spec,
        at,
        previous,
        drafts,
        () => makeId("evt", ulidOf((minted += 1))),
        subscribers,
      );
      const taken = new Set(
        store
          .list(EVENT)
          .map((row) => Schema.decodeUnknownSync(StoredEvent)(row.value).envelope.dedupeKey),
      );
      let head = store.get(DELIVERY_HEAD.kind, DELIVERY_HEAD.id);
      for (const envelope of envelopes) {
        if (taken.has(envelope.dedupeKey))
          throw new Error(`dedupe key already committed: ${envelope.dedupeKey}`);
        const eventKey = `${entityKey(envelope.entity)}#${pad(envelope.seq)}`;
        store.put(
          EVENT,
          eventKey,
          stored(StoredEvent, {
            cause: spec.cause,
            fingerprint: spec.fingerprint ?? null,
            envelope,
          }),
        );
        for (const subscriber of envelope.notified) {
          head = (typeof head === "number" ? head : 0) + 1;
          store.put(
            DELIVERY,
            pad(head),
            stored(StoredDelivery, {
              eventId: envelope.eventId,
              eventKey,
              subscriber,
              attempts: 0,
              nextAt: at,
            }),
          );
        }
      }
      if (head !== undefined) store.put(DELIVERY_HEAD.kind, DELIVERY_HEAD.id, head);
      return envelopes;
    },
    committed: (entity, cause) => {
      const rows = eventsOf(entity).filter((row) => row.cause === cause);
      const first = rows[0];
      if (first === undefined) return undefined;
      const prior: PriorCommit = { events: rows.map((row) => row.envelope) };
      return first.fingerprint === null ? prior : { ...prior, fingerprint: first.fingerprint };
    },
    log: (entity) => eventsOf(entity).map((row) => row.envelope),
    subscribe: (subscriber, types) => {
      for (const type of types === EVERY_TYPE ? [EVERY_TYPE] : types) {
        store.put(
          SUBSCRIPTION,
          `${subscriber}\u0000${type}`,
          stored(StoredSubscription, { subscriber, type }),
        );
      }
    },
    unsubscribe: (subscriber, types) => {
      for (const row of store.list(SUBSCRIPTION)) {
        const subscription = Schema.decodeUnknownSync(StoredSubscription)(row.value);
        if (subscription.subscriber !== subscriber) continue;
        if (types === undefined || types === EVERY_TYPE || types.includes(subscription.type))
          store.remove(SUBSCRIPTION, row.id);
      }
    },
    subscribers,
    receive: (dedupeKey, at) => {
      if (store.get(RECEIVED, dedupeKey) !== undefined) return false;
      store.put(RECEIVED, dedupeKey, at);
      return true;
    },
    due: (now, limit) => {
      const due: DueDeliveries[] = [];
      for (const head of heads()) {
        if (head.nextAt > now) continue;
        const events = deliveries()
          .filter((delivery) => delivery.subscriber === head.subscriber)
          .slice(0, limit)
          .map(
            (delivery) =>
              Schema.decodeUnknownSync(StoredEvent)(store.get(EVENT, delivery.eventKey)).envelope,
          );
        due.push({ subscriber: head.subscriber, attempts: head.attempts, events });
      }
      return due;
    },
    acknowledge: (subscriber, eventIds) => {
      for (const delivery of deliveries()) {
        if (delivery.subscriber === subscriber && eventIds.includes(delivery.eventId))
          store.remove(DELIVERY, delivery.id);
      }
    },
    defer: (subscriber, eventIds, attempts, nextAttemptAt) => {
      for (const { id, ...delivery } of deliveries()) {
        if (delivery.subscriber === subscriber && eventIds.includes(delivery.eventId)) {
          store.put(
            DELIVERY,
            id,
            stored(StoredDelivery, { ...delivery, attempts, nextAt: nextAttemptAt }),
          );
        }
      }
    },
    backlog: () => {
      const all = deliveries();
      return heads().map((head): Backlog => ({
        subscriber: head.subscriber,
        pending: all.filter((delivery) => delivery.subscriber === head.subscriber).length,
        attempts: head.attempts,
        nextAttemptAt: Instant(head.nextAt),
      }));
    },
  });
}

/** An in-memory outbox and the in-memory store it lives in, so one transaction covers both. */
export function makeEventOutboxMemory() {
  const store = makeEntityStoreMemory();
  return {
    store,
    layer: Layer.effect(EventOutbox, Effect.map(EntityStore, outboxOver)).pipe(
      Layer.provideMerge(store.layer),
    ),
  };
}

/** A fan-out a test scripts: it records every attempt, fails the subscribers in `failing`, and counts nudges. */
export function makeScriptedFanOut() {
  const attempts: { readonly subscriber: Subscriber; readonly eventIds: readonly string[] }[] = [];
  const delivered: {
    readonly subscriber: Subscriber;
    readonly events: readonly EventEnvelope[];
  }[] = [];
  const failing = new Set<Subscriber>();
  let nudges = 0;
  const fanOut: FanOut = {
    deliver: (subscriber, events) =>
      Effect.suspend(() => {
        attempts.push({ subscriber, eventIds: events.map((event) => event.eventId) });
        if (failing.has(subscriber))
          return Effect.fail(new DeliveryFailed({ subscriber, reason: "scripted to fail" }));
        delivered.push({ subscriber, events: [...events] });
        return Effect.void;
      }),
    nudge: Effect.sync(() => {
      nudges += 1;
    }),
  };
  return {
    fanOut,
    attempts,
    delivered,
    failing,
    nudges: () => nudges,
    /** Every event delivered to `subscriber`, in delivery order. */
    deliveredTo: (subscriber: Subscriber) =>
      delivered.filter((entry) => entry.subscriber === subscriber).flatMap((entry) => entry.events),
  };
}
export type ScriptedFanOut = ReturnType<typeof makeScriptedFanOut>;

/** A clock that moves only when told to, so retry deadlines can be crossed without waiting. */
export function makeManualClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    layer: Layer.succeed(Clock, Clock.of({ now: Effect.sync(() => Instant(now)) })),
    now: () => Instant(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}
export type ManualClock = ReturnType<typeof makeManualClock>;
