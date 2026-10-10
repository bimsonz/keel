import { Effect } from "effect";

/** The longest a caller may wait on an object's state: 30 s. */
export const MAX_WAIT_MS = 30_000;

/**
 * Callers waiting on this object's state: an in-DO long-poll. Every commit
 * wakes them all, and each re-reads and decides whether to answer. Nothing
 * polls: a wake comes from a commit, the deadline from one `setTimeout`.
 */
export class Waiters {
  private readonly pending = new Set<() => void>();

  /** Wakes every waiter. Called after anything that may have committed. */
  wake(): void {
    // Each waiter removes itself as it resolves; deleting the entry being visited is safe in a Set.
    for (const resolve of this.pending) resolve();
  }

  /** Resolves on the next wake, or after `ms`, whichever comes first. */
  next(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.pending.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.pending.add(done);
    });
  }

  /**
   * Reads until `ready` holds or `waitMs` (clamped to 0–30 s) runs out, then
   * answers with the last read: at the deadline, the state as it stands.
   */
  until<A, E, R>(
    waitMs: number,
    read: Effect.Effect<A, E, R>,
    ready: (value: A) => boolean,
  ): Effect.Effect<A, E, R> {
    const next = (ms: number) => this.next(ms);
    return Effect.gen(function* () {
      const deadline = Date.now() + Math.min(Math.max(waitMs, 0), MAX_WAIT_MS);
      let value = yield* read;
      while (!ready(value)) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        yield* Effect.promise(() => next(left));
        value = yield* read;
      }
      return value;
    });
  }
}
