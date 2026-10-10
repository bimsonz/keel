import { Effect, type ManagedRuntime } from "effect";
import { translateArtifactsEvent } from "./artifacts-events.ts";

/**
 * The queue doorway. Delivery is at least once, so each message is handled
 * idempotently and acknowledged or retried on its own.
 */
export function consumeQueue<R>(batch: MessageBatch, runtime: ManagedRuntime.ManagedRuntime<R, never>): Promise<void> {
  return runtime.runPromise(
    Effect.forEach(
      batch.messages,
      (message) =>
        Effect.sync(() => {
          if (batch.queue.endsWith("artifacts-events")) {
            const event = translateArtifactsEvent(message.body);
            // The WorkspacePool DO takes WorkspaceForked once it is built; until then it is recorded only.
            if (event !== null) console.log("artifacts event", event._tag, event.workspaceId);
          }
          message.ack();
        }),
      { concurrency: 8, discard: true },
    ),
  );
}
