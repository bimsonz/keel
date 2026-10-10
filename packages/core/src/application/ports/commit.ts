import { Effect, Result } from "effect";
import type { EventEnvelope, Instant } from "../../domain/kernel/index.ts";
import { Clock } from "./clock.ts";
import { EntityStore } from "./entity-store.ts";
import { type CommitSpec, type EventDraft, EventOutbox } from "./event-outbox.ts";

/** What a decision sees inside the transaction: the state and the outbox, both synchronous, and the time. */
export interface Transaction {
  readonly store: (typeof EntityStore)["Service"];
  readonly outbox: (typeof EventOutbox)["Service"];
  /**
   * The one instant of this transaction: the events are stamped with it, so a
   * decision and the `evolve` that writes its state read the time here, never
   * from a clock of their own.
   */
  readonly at: Instant;
}

/** A decision's outcome: the events to commit, and what the caller gets back. */
export interface Transition<A> {
  readonly drafts: readonly EventDraft[];
  readonly value: A;
  /**
   * Runs inside the same transaction once the events are appended: for a
   * subscription change that must not alter these events' `notified[]` (the
   * agent an adoption replaces still hears of it).
   */
  readonly after?: (tx: Transaction) => void;
}

export type Committed<A> =
  | { readonly duplicate: false; readonly value: A; readonly events: readonly EventEnvelope[] }
  /** The cause had already committed: nothing was written. `sameCommand` is false when its fingerprint differs. */
  | {
      readonly duplicate: true;
      readonly sameCommand: boolean;
      readonly events: readonly EventEnvelope[];
    };

/** Thrown inside the transaction to roll back a refused decision's writes. */
class Rollback extends Error {
  constructor() {
    super("a refused decision is rolled back");
  }
}

/**
 * The one way a Durable Object changes state. Reads the time first, then in
 * one `EntityStore.transaction`: returns what `spec.cause` already committed
 * if it did; otherwise runs `decide` (which reads state, decides and writes
 * state, all synchronously, at `tx.at`) and appends its events to the outbox,
 * stamped with that same instant. A refusal rolls back every write `decide`
 * made. Nothing awaits between reading the state and committing the events,
 * so no other request can interleave.
 */
export const commit = <A, E>(
  spec: CommitSpec,
  decide: (tx: Transaction) => Result.Result<Transition<A>, E>,
): Effect.Effect<Committed<A>, E, Clock | EntityStore | EventOutbox> =>
  Effect.gen(function* () {
    const at = yield* (yield* Clock).now;
    const store = yield* EntityStore;
    const outbox = yield* EventOutbox;
    let refusal: Result.Failure<Transition<A>, E> | undefined;
    try {
      return store.transaction((): Committed<A> => {
        const prior = outbox.committed(spec.entity, spec.cause);
        if (prior !== undefined)
          return {
            duplicate: true,
            sameCommand: prior.fingerprint === spec.fingerprint,
            events: prior.events,
          };
        const tx: Transaction = { store, outbox, at };
        const decided = decide(tx);
        if (Result.isFailure(decided)) {
          refusal = decided;
          throw new Rollback();
        }
        const events = outbox.append(spec, at, decided.success.drafts);
        decided.success.after?.(tx);
        return { duplicate: false, value: decided.success.value, events };
      });
    } catch (thrown) {
      if (thrown instanceof Rollback && refusal !== undefined)
        return yield* Effect.fail(refusal.failure);
      throw thrown;
    }
  });
