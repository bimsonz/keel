import { Context, type Effect } from "effect";
import type { ProjectId } from "../../domain/kernel/index.ts";

/** A lane as a reader of its project is shown it: how many changes wait in it, and how many are in flight. */
export interface LaneStanding {
  /** The lane's id, as its events name it: `lane:<projectId>:<name>`. */
  readonly id: string;
  /** Changes queued and not yet in a batch. */
  readonly queued: number;
  /** The members of the batch in flight: formed, and not yet landed or sent back. */
  readonly inFlight: number;
}

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
     * The project's lanes as a reader is shown them, both counts in changes.
     * A project has one lane today, and a lane no change ever joined is shown
     * empty, never a defect.
     */
    readonly view: (projectId: ProjectId) => Effect.Effect<readonly LaneStanding[]>;
    /**
     * Tells the lane that the platform reported a KeelVerify instance ended
     * without completing. It is a hint: the lane reads the instance's
     * standing itself and settles only its own batch in flight, so a
     * duplicate, a late or a stray report changes nothing.
     */
    readonly verificationEnded: (laneId: string, instanceId: string) => Effect.Effect<void>;
  }
>()("keel/Lanes") {}
