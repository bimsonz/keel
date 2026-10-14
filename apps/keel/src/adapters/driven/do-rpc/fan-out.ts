import { TrunkAdvanced } from "@keeltown/core/domain/integration";
import { ConflictSuspected } from "@keeltown/core/domain/verification";
import { EventEnvelope } from "@keeltown/core/kernel";
import { DeliveryFailed, type FanOut, PROJECTOR, type Subscriber } from "@keeltown/core/ports";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import {
  DeliverJob,
  decodeExit,
  deliverInstanceId,
  EventCodecs,
} from "../../../rpc/index.ts";

/** A Durable Object's `receive`, reached by its address, which is also the object's name. */
type Receive = (envelopes: unknown) => Promise<unknown>;

/**
 * The Durable Object each address prefix lives in. An object still running the
 * previous version may not answer `receive` yet: the call throws, and is retried.
 */
function receiverFor(env: Env, subscriber: Subscriber): Receive | undefined {
  if (subscriber === PROJECTOR)
    return (envelopes) =>
      env.PROJECTOR.get(env.PROJECTOR.idFromName(subscriber)).receive(envelopes);
  switch (subscriber.slice(0, subscriber.indexOf(":"))) {
    case "agent":
      return (envelopes) =>
        env.AGENT_SESSION.get(env.AGENT_SESSION.idFromName(subscriber)).receive(envelopes);
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
      return (envelopes) =>
        env.WORKSPACE_POOL.get(env.WORKSPACE_POOL.idFromName(subscriber)).receive(envelopes);
    default:
      return undefined;
  }
}

/** The Workflows an event can start, by the name a subscription uses (`workflow:<Name>`). */
function workflowFor(env: Env, name: string): Workflow | undefined {
  switch (name) {
    case "Precheck":
      return env.PRECHECK;
    case "Probe":
      return env.PROBE;
    case "Deliver":
      return env.DELIVER;
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
  return new DeliveryFailed({
    subscriber,
    reason: reason instanceof Error ? reason.message : String(reason),
  });
}

function deliverToObject(
  receive: Receive,
  subscriber: Subscriber,
  events: readonly EventEnvelope[],
) {
  return Effect.tryPromise({
    try: () => receive(events.map((event) => encodeEnvelope(event))),
    catch: (cause) => failed(subscriber, cause),
  }).pipe(
    Effect.flatMap((answer) => {
      const exit = decodeExitOrDefect(answer);
      return Exit.isSuccess(exit)
        ? Effect.void
        : Effect.fail(failed(subscriber, Cause.pretty(exit.cause)));
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

function startWorkflow(
  workflow: Workflow,
  name: string,
  subscriber: Subscriber,
  events: readonly EventEnvelope[],
) {
  return Effect.forEach(
    events,
    (event) => {
      const id = workflowInstanceId(name, event);
      const params = {
        ...(typeof event.payload === "object" && event.payload !== null ? event.payload : {}),
        eventId: event.eventId,
      };
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
 * The Probe a ConflictSuspected starts: one instance per conflict,
 * `probe-<conflictId>`, so a redelivery or a second suspicion of the same
 * conflict starts nothing new. Without the subject's key (an older event) or
 * the project, no Probe can reach the conflict's Subject DO: the delivery is
 * acknowledged with the reason, so it never sticks.
 */
export function probeStart(event: EventEnvelope):
  | {
      readonly id: string;
      readonly params: {
        readonly projectId: string;
        readonly key: string;
        readonly conflictId: string;
      };
    }
  | { readonly skipped: string } {
  if (event.type !== "ConflictSuspected")
    return { skipped: `${event.eventId} is ${event.type}, not ConflictSuspected` };
  const payload = Schema.decodeUnknownOption(ConflictSuspected)(event.payload);
  if (Option.isNone(payload)) return { skipped: `${event.eventId} names no conflict` };
  const { conflictId, subjectKey } = payload.value;
  if (subjectKey === undefined || event.project === undefined)
    return {
      skipped: `conflict ${conflictId} (${event.eventId}) names no ${subjectKey === undefined ? "subject key" : "project"}, so no Probe can reach it`,
    };
  return {
    id: `probe-${conflictId}`,
    params: { projectId: event.project, key: subjectKey, conflictId },
  };
}

/**
 * The Deliver a TrunkAdvanced starts: one instance per project and trunk
 * commit, `deliver-<projectId>-<to>`, so a redelivery starts nothing new.
 * Its job names the candidates that landed, in group order. An event that
 * names no advance is acknowledged with the reason, so it never sticks.
 */
export function deliverStart(event: EventEnvelope):
  | { readonly id: string; readonly params: typeof DeliverJob.Encoded }
  | { readonly skipped: string } {
  if (event.type !== "TrunkAdvanced")
    return { skipped: `${event.eventId} is ${event.type}, not TrunkAdvanced` };
  const payload = Schema.decodeUnknownOption(TrunkAdvanced)(event.payload);
  if (Option.isNone(payload)) return { skipped: `${event.eventId} names no trunk advance` };
  const { projectId, to, landings } = payload.value;
  const candidates = [...new Set(landings.map((landing) => landing.candidateId))];
  return {
    id: deliverInstanceId(projectId, to),
    params: Schema.encodeSync(DeliverJob)({ projectId, to, candidates }),
  };
}

/** Starts one instance per event under the id `start` names, or acknowledges an event it skips. */
function startKeyed(
  workflow: Workflow,
  subscriber: Subscriber,
  events: readonly EventEnvelope[],
  startOf: (
    event: EventEnvelope,
  ) => { readonly id: string; readonly params: object } | { readonly skipped: string },
) {
  return Effect.forEach(
    events,
    (event) => {
      const start = startOf(event);
      if ("skipped" in start)
        return Effect.sync(() =>
          console.error(JSON.stringify({ ops: "fan-out", subscriber, problem: start.skipped })),
        );
      return Effect.tryPromise({
        try: async () => {
          try {
            await workflow.create(start);
          } catch (cause) {
            // Already started for this key: that is the delivery.
            if (!(await exists(workflow, start.id))) throw cause;
          }
        },
        catch: (cause) => failed(subscriber, cause),
      });
    },
    { discard: true },
  );
}

/** What a send to a waiting instance needs of its Workflow binding. */
export interface InstanceEvents {
  get(id: string): Promise<{
    sendEvent(event: { readonly type: string; readonly payload: unknown }): Promise<void>;
    status(): Promise<{ readonly status: string }>;
  }>;
}

/** The bindings whose instances wait for events. */
export interface WaitingWorkflows {
  readonly PROBE: InstanceEvents;
  readonly WORLD_CHECK: InstanceEvents;
}

/**
 * The Workflows whose waiting instances an event can be sent to
 * (`workflow:<Name>/<instanceId>`): a Probe waiting for a party's submission,
 * and a world check waiting for a party's plan. A world check is started by
 * its Probe, never by an event, so it is addressed only as an instance.
 */
export function waitingWorkflowFor(
  env: WaitingWorkflows,
  name: string,
): InstanceEvents | undefined {
  switch (name) {
    case "Probe":
      return env.PROBE;
    case "KeelWorldCheck":
      return env.WORLD_CHECK;
    default:
      return undefined;
  }
}

/** States in which an instance takes no more events: a send to one is acknowledged, since nothing is waiting. */
const FINISHED: ReadonlySet<string> = new Set(["complete", "errored", "terminated"]);

/**
 * A waiting instance's subscription (`workflow:<Name>/<instanceId>`): each
 * change event is sent to it as `change-<changeId>`, with the encoded
 * envelope. A send that throws to an instance that has finished is
 * acknowledged; any other throw stays owed.
 */
export function sendToInstance(
  workflow: InstanceEvents,
  instanceId: string,
  subscriber: Subscriber,
  events: readonly EventEnvelope[],
) {
  return Effect.forEach(
    events,
    (event) =>
      Effect.tryPromise({
        try: async () => {
          const instance = await workflow.get(instanceId);
          try {
            await instance.sendEvent({
              type: `change-${event.entity.id}`,
              payload: encodeEnvelope(event),
            });
          } catch (cause) {
            const { status } = await instance.status();
            if (!FINISHED.has(status)) throw cause;
          }
        },
        catch: (cause) => failed(subscriber, cause),
      }),
    { discard: true },
  );
}

/**
 * The fan-out over the Worker's bindings: each address resolves to a Durable
 * Object (its `receive` RPC), a Workflow (one instance per event; a Probe,
 * one per conflict; a Deliver, one per project and trunk commit), a waiting Workflow instance (an event sent to it: a
 * Probe's, or a world check's) or the Projector. An address that resolves to nothing fails, so the event stays
 * owed and shows in the backlog instead of being dropped.
 */
export function FanOutRpc(env: Env): FanOut {
  return {
    deliver: (subscriber, events) => {
      if (subscriber.startsWith("workflow:")) {
        const address = subscriber.slice("workflow:".length);
        const slash = address.indexOf("/");
        const name = slash === -1 ? address : address.slice(0, slash);
        if (slash !== -1) {
          const waiting = waitingWorkflowFor(env, name);
          return waiting === undefined
            ? Effect.fail(failed(subscriber, `no Workflow named ${name} waits for events`))
            : sendToInstance(waiting, address.slice(slash + 1), subscriber, events);
        }
        const workflow = workflowFor(env, name);
        if (workflow === undefined)
          return Effect.fail(failed(subscriber, `no Workflow named ${name}`));
        if (name === "Probe") return startKeyed(workflow, subscriber, events, probeStart);
        if (name === "Deliver") return startKeyed(workflow, subscriber, events, deliverStart);
        return startWorkflow(workflow, name, subscriber, events);
      }
      const receive = receiverFor(env, subscriber);
      return receive === undefined
        ? Effect.fail(failed(subscriber, "no Durable Object answers this address"))
        : deliverToObject(receive, subscriber, events);
    },
    nudge: Effect.tryPromise(async () => {
      await env.PROJECTOR.get(env.PROJECTOR.idFromName(PROJECTOR)).nudge();
    }).pipe(Effect.ignore),
  };
}
