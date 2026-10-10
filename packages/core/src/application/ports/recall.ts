import { Context, type Effect } from "effect";
import type { ProjectId, SubjectId } from "../../domain/kernel/index.ts";

export interface RecallHit {
  readonly subjectId: SubjectId;
  readonly score: number;
}

/** Nearest subjects or decisions to free text. Used for routing, **never for gating**. */
export class Recall extends Context.Service<
  Recall,
  {
    readonly nearest: (
      projectId: ProjectId,
      text: string,
      k: number,
    ) => Effect.Effect<readonly RecallHit[]>;
  }
>()("keel/Recall") {}
