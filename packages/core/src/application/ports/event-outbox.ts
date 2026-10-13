import { Context, Data, type Effect, Schema } from "effect";
import {
  type Actor,
  type EntityRef,
  EventEnvelope,
  type EventId,
  type Instant,
  type ProjectId,
  type RunRef,
} from "../../domain/kernel/index.ts";
import type { Stored } from "./entity-store.ts";

/**
 * Where an event is delivered. A Durable Object's name (`agent:agt_…`,
 * `change:chg_…`, `lane:<project>:<id>`, `trunk:<project>`), a Workflow
 * (`workflow:Precheck`) or `projector`. The fan-out resolves the address, so an
 * emitter never knows how its subscribers are reached.
 */
export type Subscriber = string;

/** Subscribe to every event type the entity emits. */
export const EVERY_TYPE = "*";

/** The Projector's address. At L1 it hears every event every other object commits. */
export const PROJECTOR: Subscriber = "projector";

/** An entity as a subscription's scope names it: `<kind>:<id>`. */
export const scopeOf = (entity: EntityRef): string => `${entity.kind}:${entity.id}`;

/** What a scoped subscription is matched against: the event's entity, and the entities it affects. */
export interface EventAbout {
  readonly entity: EntityRef;
  readonly affected: readonly EntityRef[];
}

/** Whether a subscription scoped to `scope` hears this event: its entity is the scope, or it affects it. */
export const isInScope = (scope: string, about: EventAbout): boolean =>
  scopeOf(about.entity) === scope || about.affected.some((entity) => scopeOf(entity) === scope);

/** An event as a decision proposes it: the encoded payload, before the outbox numbers it. */
export interface EventDraft {
  /** The encoded payload of one of the contexts' tagged event schemas; its `_tag` is the event type. */
  readonly payload: { readonly _tag: string; readonly [field: string]: Stored };
  /** Entities, beyond the emitter, whose state this event changes or invalidates. */
  readonly affected?: readonly EntityRef[];
  /**
   * The entity whose state this event changes, when it is not the commit's own:
   * another entity the same Durable Object owns (the Change DO's verdicts). It
   * gets its own gap-free `seq`. Defaults to `CommitSpec.entity`.
   */
  readonly entity?: EntityRef;
}

/** What one transition commits for: its entity, and the cause that makes a retry a no-op. */
export interface CommitSpec {
  readonly entity: EntityRef;
  /**
   * Stable across retries of the same cause. By caller: a REST call's
   * Idempotency-Key; a Workflow's RPC `<instanceId>:<method>`; a reaction to a
   * delivered event, that event's `dedupeKey`; an alarm, `<reason>@<at>`.
   */
  readonly cause: string;
  /** The event that triggered this transition, when another entity's event did. */
  readonly causation?: EventId;
  /** Whose command this is, copied onto every event it commits. Absent when the platform caused it. */
  readonly actor?: Actor;
  /** The run of the agent whose command this is, copied beside the actor. Absent when it names none. */
  readonly run?: RunRef;
  /** The project the entity belongs to, copied onto every event it commits. */
  readonly project?: ProjectId;
  /** A hash of the command, so a cause reused for a different command can be told apart from a retry. */
  readonly fingerprint?: string;
}

/** The events a cause already committed, and the fingerprint it committed them under. */
export interface PriorCommit {
  readonly events: readonly EventEnvelope[];
  readonly fingerprint?: string;
}

/** A subscriber's due deliveries, oldest first. Only a subscriber whose oldest delivery is due appears. */
export interface DueDeliveries {
  readonly subscriber: Subscriber;
  /** Failed attempts at the oldest delivery so far. */
  readonly attempts: number;
  readonly events: readonly EventEnvelope[];
}

/** A subscriber with deliveries waiting. */
export interface Backlog {
  readonly subscriber: Subscriber;
  readonly pending: number;
  readonly attempts: number;
  readonly nextAttemptAt: Instant;
}

/**
 * The entity's events and the deliveries still owed for them, on the Durable
 * Object's own storage. Every method is synchronous, so `append` runs inside
 * the same `EntityStore.transaction` as the state it describes. Delivery
 * happens afterwards, in `flushOutbox`.
 */
export class EventOutbox extends Context.Service<
  EventOutbox,
  {
    /**
     * Numbers the drafts as their entities' next events (gap-free `seq` per
     * entity), mints their ids, and owes one delivery per subscriber of each
     * event's type at this moment, recorded in its `notified[]`. Must run
     * inside the transaction that writes the state.
     */
    readonly append: (
      spec: CommitSpec,
      at: Instant,
      drafts: readonly EventDraft[],
    ) => readonly EventEnvelope[];
    /** What `cause` already committed for this entity, if it did. */
    readonly committed: (entity: EntityRef, cause: string) => PriorCommit | undefined;
    /** The entity's events in `seq` order. Replaying them rebuilds its state. */
    readonly log: (entity: EntityRef) => readonly EventEnvelope[];
    /**
     * Owes `subscriber` every later event of these types (or of every type).
     * With a `scope`, only the events whose `entity` is that entity or whose
     * `affected[]` holds it: a batch's member hears its own batch, and nothing
     * once no event names it again.
     */
    readonly subscribe: (
      subscriber: Subscriber,
      types: readonly string[] | typeof EVERY_TYPE,
      scope?: EntityRef,
      options?: SubscribeOptions,
    ) => void;
    /**
     * Stops owing `subscriber` these types, scoped or not; every type when omitted.
     * With a `scope`, only that scope goes: the subscriber's other scopes and its
     * unscoped types stay. Deliveries already owed stay owed.
     */
    readonly unsubscribe: (
      subscriber: Subscriber,
      types?: readonly string[] | typeof EVERY_TYPE,
      scope?: EntityRef,
    ) => void;
    /**
     * The subscribers an event of this type would be delivered to now: every
     * unscoped one, and each scoped one whose scope `about` names.
     */
    readonly subscribers: (type: string, about?: EventAbout) => readonly Subscriber[];
    /**
     * The receiving side: records that an event with this `dedupeKey` arrived.
     * True the first time, false for a redelivery. Must run inside the
     * transaction that applies the reaction.
     */
    readonly receive: (dedupeKey: string, at: Instant) => boolean;
    /** Each subscriber's due deliveries, at most `limit` events each. */
    readonly due: (now: Instant, limit: number) => readonly DueDeliveries[];
    /** Deliveries that reached their subscriber. Called only after the subscriber answered. */
    readonly acknowledge: (subscriber: Subscriber, eventIds: readonly string[]) => void;
    /** Deliveries that failed: try again at `nextAttemptAt`. */
    readonly defer: (
      subscriber: Subscriber,
      eventIds: readonly string[],
      attempts: number,
      nextAttemptAt: Instant,
    ) => void;
    /** Every subscriber still owed something. */
    readonly backlog: () => readonly Backlog[];
  }
>()("keel/EventOutbox") {}

/** A subscriber did not take a delivery: unreachable, threw, or answered with a failure. */
export class DeliveryFailed extends Data.TaggedError("DeliveryFailed")<{
  readonly subscriber: Subscriber;
  readonly reason: string;
}> {}

/**
 * How committed events leave the Durable Object. Built by composition from the
 * Worker's bindings; the outbox never knows how an address is reached.
 */
export interface FanOut {
  /** Hands these events, oldest first, to one subscriber. Succeeds only once the subscriber has taken them all. */
  readonly deliver: (
    subscriber: Subscriber,
    events: readonly EventEnvelope[],
  ) => Effect.Effect<void, DeliveryFailed>;
  /** Tells the Projector there is something new to drain. Best effort: the next flush nudges again. */
  readonly nudge: Effect.Effect<void>;
}

/** A failed delivery is retried after 1 s, doubling, capped at 60 s. A stalled subscriber has nothing else to wake it. */
export const REDELIVERY_CAP_MS = 60_000;

export function redeliveryDelay(attempts: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempts - 1), REDELIVERY_CAP_MS);
}

/** After this many failed attempts a subscriber's backlog is reported as stuck. It is still retried: nothing is dropped. */
export const STUCK_AFTER_ATTEMPTS = 8;

/**
 * An event's dedupe key: `<kind>:<id>/<cause>/<type>#<n>`, where `n` counts
 * events of that type within one commit (a transition may emit several of
 * one type). Unique across Keel, because it names the emitting entity, and
 * stable across retries, because the cause is.
 */
export function dedupeKeyOf(
  entity: EntityRef,
  cause: string,
  type: string,
  ordinal: number,
): string {
  return `${entity.kind}:${entity.id}/${cause}/${type}#${ordinal}`;
}

/**
 * How a subscription is held. A `once` subscriber is owed the first event
 * that notifies it and nothing after: the append that notifies it drops
 * every subscription it holds, in the same transaction.
 */
export interface SubscribeOptions {
  readonly once?: boolean;
}

/**
 * The subscribers one append notifies, event by event, with each one-shot
 * subscriber notified once: the first event that names it spends it, and
 * the events after it in the same append skip it. `spent` is what the
 * adapter then unsubscribes.
 */
export function spendingOnce(
  subscribers: (type: string, about: EventAbout) => readonly Subscriber[],
  once: ReadonlySet<Subscriber>,
): {
  readonly subscribers: (type: string, about: EventAbout) => readonly Subscriber[];
  readonly spent: ReadonlySet<Subscriber>;
} {
  const spent = new Set<Subscriber>();
  return {
    subscribers: (type, about) => {
      const found = subscribers(type, about).filter((subscriber) => !spent.has(subscriber));
      for (const subscriber of found) if (once.has(subscriber)) spent.add(subscriber);
      return found;
    },
    spent,
  };
}

/**
 * The envelopes for one commit's drafts, each numbered after its entity's
 * `previousSeq`. Every adapter builds its envelopes here, so they cannot
 * disagree on numbering or keys. Throws on a draft the envelope schema
 * rejects, which rolls back the transaction it runs in.
 */
export function envelopesFor(
  spec: CommitSpec,
  at: Instant,
  previousSeq: (entity: EntityRef) => number,
  drafts: readonly EventDraft[],
  mintId: () => EventId,
  subscribers: (type: string, about: EventAbout) => readonly Subscriber[],
): readonly EventEnvelope[] {
  const seqs = new Map<string, number>();
  const ordinals = new Map<string, number>();
  return drafts.map((draft) => {
    const entity = draft.entity ?? spec.entity;
    const type = draft.payload._tag;
    const entityKey = `${entity.kind}:${entity.id}`;
    const seq = (seqs.get(entityKey) ?? previousSeq(entity)) + 1;
    seqs.set(entityKey, seq);
    const ordinal = (ordinals.get(`${entityKey}/${type}`) ?? 0) + 1;
    ordinals.set(`${entityKey}/${type}`, ordinal);
    return Schema.decodeUnknownSync(EventEnvelope)({
      eventId: mintId(),
      type,
      entity,
      seq,
      at,
      dedupeKey: dedupeKeyOf(entity, spec.cause, type, ordinal),
      ...(spec.causation === undefined ? {} : { causation: spec.causation }),
      ...(spec.actor === undefined ? {} : { actor: spec.actor }),
      ...(spec.run === undefined ? {} : { run: spec.run }),
      ...(spec.project === undefined ? {} : { project: spec.project }),
      affected: draft.affected ?? [],
      notified: subscribers(type, { entity, affected: draft.affected ?? [] }),
      payload: draft.payload,
    });
  });
}
