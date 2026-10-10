import { DurableObject } from "cloudflare:workers";
import type { EntityRef, EventEnvelope } from "@keeltown/core/kernel";
import {
  Clock,
  EntityStore,
  type EventDraft,
  EventOutbox,
  type FanOut,
  flushOutbox,
  type Transaction,
} from "@keeltown/core/ports";
import { Effect } from "effect";
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
import { type AlarmRequest, dueAlarms, scheduleAlarm } from "./alarm.ts";
import { Waiters } from "./waiters.ts";

/** The alarm reasons the backbone owns. Every other reason is the subclass's, handed to `onDeadline`. */
export const OUTBOX_FLUSH = "outbox flush";
export const OUTBOX_REDELIVERY = "outbox redelivery";

/** What a reaction to a received event commits: events of one of this object's entities. */
export interface Reaction {
  readonly entity: EntityRef;
  readonly drafts: readonly EventDraft[];
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
export abstract class KeelObject extends DurableObject<Env> implements EventReceiverRpc {
  protected readonly runtime: DurableObjectRuntime;
  protected readonly waiters = new Waiters();
  private readonly fanOut: FanOut;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const composed = durableObjectRuntime(ctx, env);
    this.runtime = composed.runtime;
    this.fanOut = composed.fanOut;
  }

  /** Runs one call's program, arms the flush for anything it committed, and answers with the Exit envelope. */
  protected async answer<A, E>(
    codec: ExitCodec<A, E>,
    program: Effect.Effect<A, E, DurableObjectServices>,
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

  /** One of the object's own alarms came due. */
  protected async onDeadline(request: AlarmRequest): Promise<void> {
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
          const reaction = react(arrival.envelope, { store, outbox });
          if (reaction === undefined) return "ignored";
          outbox.append(
            {
              entity: reaction.entity,
              cause: arrival.dedupeKey,
              causation: arrival.envelope.eventId,
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
    return this.answer(EventCodecs.receive, program);
  }

  override async alarm(): Promise<void> {
    let flushed = false;
    for (const request of await dueAlarms(this.ctx.storage, Date.now())) {
      if (request.reason === OUTBOX_FLUSH || request.reason === OUTBOX_REDELIVERY) {
        if (!flushed) await this.flush();
        flushed = true;
      } else {
        await this.onDeadline(request);
      }
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
    }
  }
}
