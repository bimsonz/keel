import { Context, type Effect } from "effect";
import type { Intent, LiveChange, PreflightCompared } from "../../domain/coordination/index.ts";
import type { ChangeId, ProjectId } from "../../domain/kernel/index.ts";

/**
 * The live changes near an intent, as its preflight reads them: every one
 * exposure could name (a neighbour, a contradiction's holder, an
 * alternative), in change id order, and what finding them compared.
 */
export interface LiveNear {
  readonly changes: readonly LiveChange[];
  readonly compared: PreflightCompared;
}

/** A project's live changes, as its Project DO indexes them, for preflight. */
export class LiveChanges extends Context.Service<
  LiveChanges,
  {
    /**
     * The project's live changes near `intent`, read by key from the index
     * rather than all of it, `self` left out: exposure over them finds what
     * it finds over every live change.
     */
    readonly near: (
      projectId: ProjectId,
      self: ChangeId,
      intent: Intent,
    ) => Effect.Effect<LiveNear>;
  }
>()("keel/LiveChanges") {}
