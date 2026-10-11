import { Context, type Effect } from "effect";
import type { LiveChange } from "../../domain/coordination/index.ts";
import type { ProjectId } from "../../domain/kernel/index.ts";

/** A project's live changes, as its Project DO indexes them, for preflight. */
export class LiveChanges extends Context.Service<
  LiveChanges,
  {
    /** Every change of the project from its declare until it ends, with its current intent and derived effects. */
    readonly of: (projectId: ProjectId) => Effect.Effect<readonly LiveChange[]>;
  }
>()("keel/LiveChanges") {}
