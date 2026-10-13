import { DurableObject } from "cloudflare:workers";
import type { EntityRef, EventEnvelope, ProjectId } from "@keeltown/core/kernel";
import {
  Clock,
  EntityStore,
  type EventDraft,
  EventOutbox,
  EVERY_TYPE,
  PROJECTOR,
  type FanOut,
  flushOutbox,
  type Transaction,
} from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import {
  type DurableObjectRuntime,
  type DurableObjectServices,
  durableObjectRuntime,
} from "../../../composition/do.ts";
import {
  type DeliveryReceipt,
  EventCodecs,
  type EventReceiverRpc,
  type ExitCodec,
  type ExitJson,
  encodeExit,
  readDelivery,
} from "../../../rpc/index.ts";
import {
  cancelAlarm,
  dueAlarms,
  finishAlarm,
  scheduleAlarm,
  startAlarm,
  type StartedAlarm,
} from "./alarm.ts";
import { Waiters } from "./waiters.ts";

/** The alarm reasons the backbone owns. Every other reason is the subclass's, handed to `onDeadline`. */
export const OUTBOX_FLUSH = "outbox flush";
export const OUTBOX_REDELIVERY = "outbox redelivery";

/**
 * What a reaction to a received event commits: events of one of this object's
 * entities, or nothing (the event is recorded and taken all the same).
 */
export type Reaction =
  | {
      readonly entity: EntityRef;
      readonly drafts: readonly EventDraft[];
      /** The project the entity belongs to, stamped on the events, as `CommitSpec.project`. */
      readonly project?: ProjectId;
    }
  | { readonly drafts: readonly [] };

export interface KeelObjectOptions {
  /** Whether the Projector hears every event this object commits; true but for the Projector itself. */
  readonly projected?: boolean;
}

/**
 * The base of every Keel Durable Object in `keel`: its runtime, the event
 * backbone's receiving side, and its one alarm.
 *
 * - A method answers through `answer(codec, program)`. The program commits with
 *   `commit` (from `@keeltown/core/ports`); `answer` then arms the outbox flush
 *   if anything is owed, so committed events leave without anyone polling.
 * - Events from other objects arrive through `receive`. Each is recorded and
 *   reacted to in one transaction, so a redelivery is a no-op and a crash
 *   leaves it unreceived. Override `react` to handle them.
 * - Override `onDeadline` for the object's own alarms, armed with `scheduleAlarm`.
 * - A method that long-polls waits on `waiters`, which every answer and alarm wakes.
 */
export abstract class KeelObjectWith<R> extends DurableObject<Env> implements EventReceiverRpc {
  protected readonly runtime: DurableObjectRuntime<R>;
  protected readonly waiters = new Waiters();
  /** How this object's events reach their subscribers; the Lane re-offers through it too. */
  protected readonly fanOut: FanOut;

  /** `driven` holds the adapters the object's own use-cases need beyond the backbone, built in composition. */
  constructor(
    ctx: DurableObjectState,
    env: Env,
    driven: Layer.Layer<R>,
    options: KeelObjectOptions = {},
  ) {
    super(ctx, env);
    const composed = durableObjectRuntime(ctx, env, driven);
    this.runtime = composed.runtime;
    this.fanOut = composed.fanOut;
    if (options.projected ?? true) {
      // The console's feed is complete only if the Projector hears everything, whoever else subscribed.
      const runtime = this.runtime;
      void ctx.blockConcurrencyWhile(() =>
        runtime.runPromise(
          Effect.map(EventOutbox, (outbox) => outbox.subscribe(PROJECTOR, EVERY_TYPE)),
        ),
      );
    }
  }

  /** Runs one call's program, arms the flush for anything it committed, and answers with the Exit envelope. */
  protected async answer<A, E>(
    codec: ExitCodec<A, E>,
    program: Effect.Effect<A, E, DurableObjectServices | R>,
  ): Promise<ExitJson> {
    const exit = await this.runtime.runPromiseExit(program);
    this.waiters.wake();
    await this.armFlush();
    return encodeExit(codec, exit);
  }

  /**
   * A received event, inside the transaction that records it. Read and write
   * state through `tx`, synchronously; return the events to commit, if any.
   * The default ignores every event.
   */
  protected react(_event: EventEnvelope, _tx: Transaction): Reaction | undefined {
    return undefined;
  }

  /**
   * Runs once a delivery's transactions have returned, whatever they decided:
   * for what must leave the object only after its state is committed (a
   * WebSocket send is outside the output gate). The default does nothing.
   */
  protected async received(): Promise<void> {}

  /**
   * One of the object's own alarms came due. It is run again, with a higher
   * `starts`, when the invocation that ran it died: a handler resumes from
   * what it last committed, so a second run does only what the first left.
   */
  protected async onDeadline(request: StartedAlarm): Promise<void> {
    throw new Error(`${this.constructor.name} armed "${request.reason}" but handles no deadline`);
  }

  async receive(envelopes: unknown): Promise<ExitJson> {
    const react = (event: EventEnvelope, tx: Transaction) => this.react(event, tx);
    const program = Effect.gen(function* () {
      const at = yield* (yield* Clock).now;
      const store = yield* EntityStore;
      const outbox = yield* EventOutbox;
      const receipt = { accepted: 0, duplicates: 0, ignored: 0 };
      for (const arrival of readDelivery(envelopes)) {
        const outcome = store.transaction((): keyof DeliveryReceipt => {
          if (!outbox.receive(arrival.dedupeKey, at)) return "duplicates";
          if (arrival.envelope === undefined) return "ignored";
          const reaction = react(arrival.envelope, { store, outbox, at });
          if (reaction === undefined) return "ignored";
          if (!("entity" in reaction)) return "accepted";
          outbox.append(
            {
              entity: reaction.entity,
              cause: arrival.dedupeKey,
              causation: arrival.envelope.eventId,
              ...(reaction.project === undefined ? {} : { project: reaction.project }),
            },
            at,
            reaction.drafts,
          );
          return "accepted";
        });
        receipt[outcome] += 1;
      }
      return receipt;
    });
    try {
      return await this.answer(EventCodecs.receive, program);
    } finally {
      await this.received();
    }
  }

  override async alarm(): Promise<void> {
    let flushed = false;
    const now = Date.now();
    const { due, abandoned } = await dueAlarms(this.ctx.storage, now);
    for (const request of abandoned)
      console.error(
        `${this.constructor.name} ${this.ctx.id.name ?? this.ctx.id.toString()} gave up on "${request.reason}": started ${request.starts} times and never finished`,
      );
    for (const found of due) {
      // Counted as started only now, so a request waiting behind one that dies is not counted with it.
      const request = await startAlarm(this.ctx.storage, found, now);
      if (request === undefined) continue;
      if (request.reason === OUTBOX_FLUSH || request.reason === OUTBOX_REDELIVERY) {
        if (!flushed) await this.flush();
        flushed = true;
      } else {
        await this.onDeadline(request);
      }
      // Only now is the request done: an invocation that dies above leaves it to be run again.
      await finishAlarm(this.ctx.storage, request);
    }
    this.waiters.wake();
    await this.armFlush();
  }

  /** Arms a flush now if a delivery is due. Deliveries waiting on a retry already have their deadline. */
  private async armFlush(): Promise<void> {
    const owed = await this.runtime.runPromise(
      Effect.gen(function* () {
        const now = yield* (yield* Clock).now;
        return (yield* EventOutbox).due(now, 1).length > 0;
      }),
    );
    if (owed)
      await scheduleAlarm(this.ctx.storage, {
        kind: "debounce",
        reason: OUTBOX_FLUSH,
        at: Date.now(),
      });
  }

  private async flush(): Promise<void> {
    const report = await this.runtime.runPromise(flushOutbox(this.fanOut));
    if (report.stuck.length > 0) console.warn("outbox backlog stuck", JSON.stringify(report.stuck));
    if (report.nextAttemptAt !== undefined) {
      await scheduleAlarm(this.ctx.storage, {
        kind: "deadline",
        reason: OUTBOX_REDELIVERY,
        at: report.nextAttemptAt,
      });
    } else {
      // Nothing waits on a retry any more: an earlier failure's redelivery has nothing left to do.
      await cancelAlarm(this.ctx.storage, OUTBOX_REDELIVERY);
    }
  }
}

/** A Keel Durable Object whose use-cases need nothing beyond the backbone. */
export abstract class KeelObject extends KeelObjectWith<never> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, Layer.empty);
  }
}
