import { Result, Schema } from "effect";
import {
  type AgentId,
  type ChangeId,
  type Committed,
  IllegalTransition,
  type Instant,
  type NextAction,
  type SketchId,
  type WorkspaceId,
} from "../kernel/index.ts";
import { SketchNotFound, SketchStateRefused } from "./errors.ts";
import { SketchDiscarded, SketchExpired, SketchOpened, SketchPromoted } from "./events.ts";
import type { Sketch } from "./sketch.ts";

/** The events the WorkspacePool DO commits for one sketch. */
export const SketchEvent = Schema.Union([
  SketchOpened,
  SketchPromoted,
  SketchExpired,
  SketchDiscarded,
]);
export type SketchEvent = typeof SketchEvent.Type;

export type SketchCommand =
  | {
      readonly _tag: "Open";
      readonly agentId: AgentId;
      readonly workspaceId: WorkspaceId;
      readonly expiresAt: Instant;
    }
  /** `declare --from-sketch`: the sketch becomes a change. */
  | { readonly _tag: "Promote"; readonly changeId: ChangeId }
  | { readonly _tag: "Discard"; readonly by: string }
  /** The TTL deadline alarm. */
  | { readonly _tag: "Expire" };

/** Facts from I/O: the time, and the sketch this decision is about. */
export interface SketchFacts {
  readonly now: Instant;
  readonly sketchId: SketchId;
}

export type SketchRejection = SketchNotFound | SketchStateRefused;

type Decision = Result.Result<readonly SketchEvent[], SketchRejection>;

/** Whether the sketch is past its deadline at `now`: computed on read, so the alarm only makes it visible. */
export const sketchExpired = (sketch: Sketch, now: Instant): boolean => now >= sketch.expiresAt;

const declareInstead: NextAction = {
  kind: "call",
  title: "Declare a change for the idea, or open a new sketch",
  operationId: "declare",
};

/**
 * Decides a command on a sketch (docs/domain/state-machines.md § Sketch). Its
 * deadline is read from `expiresAt` and `facts.now`: once it has passed, the
 * sketch can no longer be promoted or discarded, alarm or no alarm.
 */
export const decideSketch = (
  state: Sketch | undefined,
  command: SketchCommand,
  facts: SketchFacts,
): Decision => {
  if (state === undefined) {
    return command._tag === "Open"
      ? Result.succeed([
          SketchOpened.make({
            sketchId: facts.sketchId,
            agentId: command.agentId,
            workspaceId: command.workspaceId,
            expiresAt: command.expiresAt,
          }),
        ])
      : Result.fail(new SketchNotFound({ sketchId: facts.sketchId }));
  }
  const sketch = state;
  const sketchId = sketch.id;
  const refuse = (expired: boolean): Decision =>
    Result.fail(
      new SketchStateRefused({
        sketchId,
        state: sketch.state,
        command: command._tag,
        ...(expired ? { reason: "expired" as const } : {}),
        nextActions: [declareInstead],
      }),
    );
  const live = sketch.state === "open" && !sketchExpired(sketch, facts.now);
  switch (command._tag) {
    case "Open":
      return refuse(false);
    case "Promote":
      return live
        ? Result.succeed([SketchPromoted.make({ sketchId, changeId: command.changeId })])
        : refuse(sketch.state === "open");
    case "Discard":
      return live
        ? Result.succeed([SketchDiscarded.make({ sketchId, by: command.by })])
        : refuse(sketch.state === "open");
    case "Expire":
      // An alarm with nothing to make visible commits nothing; the pool re-arms only while the sketch is open.
      return sketch.state === "open" && sketchExpired(sketch, facts.now)
        ? Result.succeed([SketchExpired.make({ sketchId })])
        : Result.succeed([]);
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Sketch | undefined, event: SketchEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to a sketch ${state === undefined ? "not yet opened" : state.state}`,
  );
};

/** Folds one committed event into the sketch, with its own from-table; anything else throws `IllegalTransition`. */
export const evolveSketch = (
  state: Sketch | undefined,
  committed: Committed<SketchEvent>,
): Sketch => {
  const event = committed.payload;
  if (state === undefined) {
    return event._tag === "SketchOpened"
      ? {
          id: event.sketchId,
          agentId: event.agentId,
          workspaceId: event.workspaceId,
          expiresAt: event.expiresAt,
          state: "open",
        }
      : illegal(state, event);
  }
  const sketch = state;
  if (sketch.state !== "open" || event.sketchId !== sketch.id) return illegal(sketch, event);
  const expired = sketchExpired(sketch, committed.at);
  switch (event._tag) {
    case "SketchOpened":
      return illegal(sketch, event);
    case "SketchPromoted":
      return expired
        ? illegal(sketch, event)
        : { ...sketch, state: "promoted", changeId: event.changeId };
    case "SketchDiscarded":
      return expired ? illegal(sketch, event) : { ...sketch, state: "discarded" };
    case "SketchExpired":
      return expired ? { ...sketch, state: "expired" } : illegal(sketch, event);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
};

/** Rebuilds a sketch from its events in `seq` order. */
export const replaySketch = (events: readonly Committed<SketchEvent>[]): Sketch | undefined =>
  events.reduce<Sketch | undefined>((state, event) => evolveSketch(state, event), undefined);
