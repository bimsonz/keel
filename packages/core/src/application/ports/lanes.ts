import { Context, type Effect } from "effect";
import type { ProjectId } from "../../domain/kernel/index.ts";

/** A project's lanes, through their Lane DOs (`lane:<projectId>:<name>`). */
export class Lanes extends Context.Service<
  Lanes,
  {
    /**
     * Stops every lane of the project, for good (its project was deleted):
     * each drops its queue and its batch in flight, so no batch forms and none
     * is re-offered to trunk, and from here on hears no event and takes no
     * verdict. Idempotent.
     */
    readonly destroy: (projectId: ProjectId, by: string) => Effect.Effect<void>;
  }
>()("keel/Lanes") {}
