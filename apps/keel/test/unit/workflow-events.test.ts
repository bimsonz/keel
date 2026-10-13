// Workflows' report that a KeelVerify instance ended without completing, from
// the queue to the instance's lane. The payloads are the ones a Queues event
// subscription delivered on 13 Oct 2026 (account and subscription ids
// masked), so the doorway is tested against what the platform really sends.
import { describe, expect, it } from "@effect/vitest";
import { instanceOf } from "@keeltown/core/application/integration";
import { makeId } from "@keeltown/core/kernel";
import { Lanes } from "@keeltown/core/ports";
import { makeLanesMemory } from "@keeltown/testing";
import { Effect, Layer, ManagedRuntime } from "effect";
import { consumeQueue } from "../../src/adapters/driving/queue/consumer.ts";
import { translateWorkflowEvent } from "../../src/adapters/driving/queue/workflow-events.ts";

/** One captured event, with its type and instance swapped in. */
const captured = (kind: string, instanceId: string) => ({
  type: `cf.workflows.workflow.instance.${kind}`,
  source: { workflowName: "keel-verify-batch", type: "workflows.workflow" },
  metadata: {
    accountId: "0".repeat(32),
    eventSubscriptionId: "0".repeat(32),
    eventSchemaVersion: 1,
    eventTimestamp: "2026-10-13T00:23:17.325Z",
  },
  payload: { versionId: "9b5b1c68-d10e-433f-828c-e0cf8b8a81a9", instanceId },
});

const LANE = `lane:${makeId("prj", "01J9ZZZZZZZZZZZZZZZZZZZZZZ")}:main`;
const INSTANCE = instanceOf(LANE, `evt_${"0".repeat(26)}`);

describe("Workflows' instance events at the queue's doorway", () => {
  it("[wfevent.translate-live] an errored and a terminated instance are read from the captured payload, as an object and as a JSON string", () => {
    for (const kind of ["errored", "terminated"]) {
      const event = captured(kind, INSTANCE);
      expect(translateWorkflowEvent(event)).toEqual({ instanceId: INSTANCE });
      expect(translateWorkflowEvent(JSON.stringify(event))).toEqual({
        instanceId: INSTANCE,
      });
    }
  });

  it("[wfevent.translate-others] every other event of an instance, and anything unreadable, is no report", () => {
    for (const kind of ["queued", "started", "paused", "completed"])
      expect(translateWorkflowEvent(captured(kind, INSTANCE))).toBeNull();
    const errored = captured("errored", INSTANCE);
    for (const unreadable of [
      { ...errored, type: "cf.artifacts.repo.pushed" },
      { ...errored, payload: { versionId: "v1" } },
      { ...errored, payload: { instanceId: "" } },
      "{ not json",
      "",
      null,
      42,
    ])
      expect(translateWorkflowEvent(unreadable)).toBeNull();
  });
});

/** A queue message that records how it was settled. */
const message = (id: string, body: unknown) => {
  const settled: string[] = [];
  return {
    settled,
    message: {
      id,
      timestamp: new Date(0),
      body,
      attempts: 1,
      ack: () => void settled.push("ack"),
      retry: () => void settled.push("retry"),
    },
  };
};

const batchOf = (messages: readonly ReturnType<typeof message>[]): MessageBatch => ({
  queue: "keel-staging-jobs",
  messages: messages.map((m) => m.message),
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  ackAll: () => undefined,
  retryAll: () => undefined,
});

describe("the queue consumer", () => {
  it("[queue.instance-ended] an ended instance's lane is told and its message acknowledged; a message of no known kind is acknowledged and tells no lane", async () => {
    const lanes = makeLanesMemory();
    const runtime = ManagedRuntime.make(lanes.layer);
    const ended = message("m1", JSON.stringify(captured("errored", INSTANCE)));
    const completed = message("m2", captured("completed", INSTANCE));
    const stray = message("m3", captured("terminated", "keel-verify-evt_from-before"));
    await consumeQueue(batchOf([ended, completed, stray]), runtime);
    expect(lanes.ended).toEqual([{ laneId: LANE, instanceId: INSTANCE }]);
    expect(ended.settled).toEqual(["ack"]);
    expect(completed.settled).toEqual(["ack"]);
    expect(stray.settled).toEqual(["ack"]);
    await runtime.dispose();
  });

  it("[queue.instance-ended-retry] a lane that could not be told retries its own message and no other", async () => {
    const told: string[] = [];
    const runtime = ManagedRuntime.make(
      Layer.succeed(
        Lanes,
        Lanes.of({
          destroy: () => Effect.void,
          view: () => Effect.die(new Error("the queue never reads a lane")),
          verificationEnded: (laneId, instanceId) =>
            instanceId.endsWith("1")
              ? Effect.die(new Error(`${laneId} is unreachable`))
              : Effect.sync(() => void told.push(instanceId)),
        }),
      ),
    );
    const failing = message("m1", captured("errored", instanceOf(LANE, `evt_${"1".repeat(26)}`)));
    const fine = message("m2", captured("terminated", INSTANCE));
    await consumeQueue(batchOf([failing, fine]), runtime);
    expect(failing.settled).toEqual(["retry"]);
    expect(fine.settled).toEqual(["ack"]);
    expect(told).toEqual([INSTANCE]);
    await runtime.dispose();
  });
});
