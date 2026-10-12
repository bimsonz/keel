import { Context, type Effect } from "effect";
import type { ChangeNotFound, ChangeState } from "../../domain/coordination/index.ts";
import type { ChangeId } from "../../domain/kernel/index.ts";
import type { PartyWorld, PlanState } from "../verification/index.ts";
import type { Subscriber } from "./event-outbox.ts";

/**
 * A party to a conflict as the Probe Workflow reads it: the world it stands
 * for (its current submission, or the commit it landed as over that commit's
 * first parent); Waiting, when it has no current submission yet and the
 * subscriber will hear its next ChangeSubmitted, ChangeWithdrawn or
 * ChangeSuperseded; or Gone, withdrawn or superseded (a landed change whose
 * landing commit is unknown reads as Gone too).
 */
export type PartyAnswer =
  | PartyWorld
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Gone"; readonly state: ChangeState };

/**
 * A party's plan as a world check reads it: compiled; none, in the state the
 * change is in; or Waiting, when its Precheck is still to answer and the
 * subscriber will hear the change's next PlanCompiled, or the event that ends
 * it without one.
 */
export type PlanAnswer =
  | Exclude<PlanState, { readonly _tag: "Pending" }>
  | { readonly _tag: "Waiting" };

/**
 * The changes a conflict names, through the Change DO: what the Probe
 * Workflow builds each party's world from. A change's head is the commit it
 * last submitted, never a workspace branch's moving head, so a probe's
 * evidence cites a fixed commit.
 */
export class ProbeChanges extends Context.Service<
  ProbeChanges,
  {
    /**
     * The party as it stands. Waiting records `subscriber` (one-shot, in the
     * same transaction as the read), so no submission between the read and
     * the wait is missed.
     */
    readonly awaitSubmission: (
      changeId: ChangeId,
      subscriber: Subscriber,
    ) => Effect.Effect<PartyAnswer, ChangeNotFound>;
    /**
     * The plan of the change's current submission, by core's `planStateOf`.
     * Waiting records `subscriber` (one-shot, in the same transaction as the
     * read), so no PlanCompiled between the read and the wait is missed.
     */
    readonly awaitPlan: (
      changeId: ChangeId,
      subscriber: Subscriber,
    ) => Effect.Effect<PlanAnswer, ChangeNotFound>;
  }
>()("keel/ProbeChanges") {}
