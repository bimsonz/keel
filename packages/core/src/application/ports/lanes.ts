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
    /**
     * Tells the lane that the platform reported a KeelVerify instance ended
     * without completing. It is a hint: the lane reads the instance's
     * standing itself and settles only its own batch in flight, so a
     * duplicate, a late or a stray report changes nothing.
     */
    readonly verificationEnded: (laneId: string, instanceId: string) => Effect.Effect<void>;
  }
>()("keel/Lanes") {}
