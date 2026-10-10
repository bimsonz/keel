import { Effect, type ManagedRuntime } from "effect";

/**
 * The queue doorway for background jobs. Delivery is at least once, so each
 * job is handled idempotently by its dedupe key and acknowledged or retried on
 * its own. No job kinds exist yet; each lane adds its own.
 */
export function consumeQueue<R>(
  batch: MessageBatch,
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
): Promise<void> {
  return runtime.runPromise(
    Effect.forEach(
      batch.messages,
      (message) =>
        Effect.sync(() => {
          console.log("job", batch.queue, message.id);
          message.ack();
        }),
      { concurrency: 8, discard: true },
    ),
  );
}
