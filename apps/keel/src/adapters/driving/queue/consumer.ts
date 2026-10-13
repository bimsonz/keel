import { instanceEnded } from "@keeltown/core/application/integration";
import type { Lanes } from "@keeltown/core/ports";
import { Cause, Effect, Exit, type ManagedRuntime } from "effect";
import { translateWorkflowEvent } from "./workflow-events.ts";

/**
 * The queue doorway for background jobs. Delivery is at least once, so each
 * job is handled idempotently and acknowledged or retried on its own. One
 * kind so far: Workflows' report that a KeelVerify instance ended without
 * completing, which is passed to the instance's lane. A lane that could not
 * be told retries its message; a message of no known kind is acknowledged.
 */
export function consumeQueue(
  batch: MessageBatch,
  runtime: ManagedRuntime.ManagedRuntime<Lanes, never>,
): Promise<void> {
  return runtime.runPromise(
    Effect.forEach(
      batch.messages,
      (message) => {
        const ended = translateWorkflowEvent(message.body);
        if (ended === null)
          return Effect.sync(() => {
            console.log("job", batch.queue, message.id);
            message.ack();
          });
        return Effect.map(Effect.exit(instanceEnded(ended.instanceId)), (told) => {
          if (Exit.isSuccess(told)) {
            console.log(`instance ${ended.instanceId} ended: its lane was ${told.value}`);
            message.ack();
            return;
          }
          console.warn(
            `instance ${ended.instanceId} ended: its lane could not be told`,
            Cause.pretty(told.cause),
          );
          message.retry();
        });
      },
      { concurrency: 8, discard: true },
    ),
  );
}
