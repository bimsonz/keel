import { EventEnvelope } from "@keeltown/core/kernel";
import { DeliveryFailed, type FanOut, type Subscriber } from "@keeltown/core/ports";
import { Cause, Effect, Exit, Schema } from "effect";
import { decodeExit, EventCodecs } from "../../../rpc/index.ts";

/** The Projector is one object for now; B4.1 may shard it or swap RPC delivery for the operation log, here only. */
export const PROJECTOR_NAME = "projector";

/** A Durable Object's `receive`, reached by its address, which is also the object's name. */
type Receive = (envelopes: unknown) => Promise<unknown>;

/**
 * The Durable Object each address prefix lives in. An object still running the
 * previous version may not answer `receive` yet: the call throws, and is retried.
 */
function receiverFor(env: Env, subscriber: Subscriber): Receive | undefined {
  if (subscriber === PROJECTOR_NAME) return (envelopes) => env.PROJECTOR.get(env.PROJECTOR.idFromName(subscriber)).receive(envelopes);
  switch (subscriber.slice(0, subscriber.indexOf(":"))) {
    case "agent":
      return (envelopes) => env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(subscriber)).receive(envelopes);
    case "change":
      return (envelopes) => env.CHANGE.get(env.CHANGE.idFromName(subscriber)).receive(envelopes);
    case "subj":
      return (envelopes) => env.SUBJECT.get(env.SUBJECT.idFromName(subscriber)).receive(envelopes);
    case "lane":
      return (envelopes) => env.LANE.get(env.LANE.idFromName(subscriber)).receive(envelopes);
    case "trunk":
      return (envelopes) => env.TRUNK.get(env.TRUNK.idFromName(subscriber)).receive(envelopes);
    case "project":
      return (envelopes) => env.PROJECT.get(env.PROJECT.idFromName(subscriber)).receive(envelopes);
    case "pool":
      return (envelopes) => env.WORKSPACE_POOL.get(env.WORKSPACE_POOL.idFromName(subscriber)).receive(envelopes);
    default:
      return undefined;
  }
}

/** The Workflows an event can start, by the name a subscription uses (`workflow:<Name>`). */
function workflowFor(env: Env, name: string): Workflow | undefined {
  switch (name) {
    case "Precheck":
      return env.PRECHECK;
    default:
      return undefined;
  }
}

/**
 * A Workflow instance's id is its name and the event's id: `precheck-evt_…`.
 * The event id is fixed when the event commits, so a redelivery names the same
 * instance and starts nothing new, while a later event (a resubmission after a
 * bounce, even at the same revision) starts its own.
 */
export function workflowInstanceId(name: string, event: EventEnvelope): string {
  return `${name.toLowerCase()}-${event.eventId}`;
}

const encodeEnvelope = Schema.encodeSync(EventEnvelope);

function failed(subscriber: Subscriber, reason: unknown) {
  return new DeliveryFailed({ subscriber, reason: reason instanceof Error ? reason.message : String(reason) });
}

function deliverToObject(receive: Receive, subscriber: Subscriber, events: readonly EventEnvelope[]) {
  return Effect.tryPromise({
    try: () => receive(events.map((event) => encodeEnvelope(event))),
    catch: (cause) => failed(subscriber, cause),
  }).pipe(
    Effect.flatMap((answer) => {
      const exit = decodeExitOrDefect(answer);
      return Exit.isSuccess(exit) ? Effect.void : Effect.fail(failed(subscriber, Cause.pretty(exit.cause)));
    }),
  );
}

function decodeExitOrDefect(answer: unknown) {
  try {
    return decodeExit(EventCodecs.receive, answer);
  } catch (cause) {
    return Exit.die(cause);
  }
}

async function exists(workflow: Workflow, id: string): Promise<boolean> {
  try {
    await workflow.get(id);
    return true;
  } catch {
    return false;
  }
}

function startWorkflow(workflow: Workflow, name: string, subscriber: Subscriber, events: readonly EventEnvelope[]) {
  return Effect.forEach(
    events,
    (event) => {
      const id = workflowInstanceId(name, event);
      const params = { ...(typeof event.payload === "object" && event.payload !== null ? event.payload : {}), eventId: event.eventId };
      return Effect.tryPromise({
        try: async () => {
          try {
            await workflow.create({ id, params });
          } catch (cause) {
            // Already started by an earlier delivery of this event: that is the delivery.
            if (!(await exists(workflow, id))) throw cause;
          }
        },
        catch: (cause) => failed(subscriber, cause),
      });
    },
    { discard: true },
  );
}

/**
 * The fan-out over the Worker's bindings: each address resolves to a Durable
 * Object (its `receive` RPC), a Workflow (one instance per event) or the
 * Projector. An address that resolves to nothing fails, so the event stays
 * owed and shows in the backlog instead of being dropped.
 */
export function FanOutRpc(env: Env): FanOut {
  return {
    deliver: (subscriber, events) => {
      if (subscriber.startsWith("workflow:")) {
        const name = subscriber.slice("workflow:".length);
        const workflow = workflowFor(env, name);
        return workflow === undefined ? Effect.fail(failed(subscriber, `no Workflow named ${name}`)) : startWorkflow(workflow, name, subscriber, events);
      }
      const receive = receiverFor(env, subscriber);
      return receive === undefined ? Effect.fail(failed(subscriber, "no Durable Object answers this address")) : deliverToObject(receive, subscriber, events);
    },
    nudge: Effect.tryPromise(async () => {
      await env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR_NAME)).nudge();
    }).pipe(Effect.ignore),
  };
}
