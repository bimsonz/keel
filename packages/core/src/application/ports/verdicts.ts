import { Context, type Effect, Schema } from "effect";
import { InstantSchema, ProjectId, type VerdictId } from "../../domain/kernel/index.ts";
import { type VerdictNotFound, VerdictIssued } from "../../domain/verification/index.ts";

/** A verdict as the feed holds it: the VerdictIssued that issued it, its project, and when. */
export const IndexedVerdict = Schema.Struct({
  verdict: VerdictIssued,
  project: ProjectId,
  issuedAt: InstantSchema,
});
export type IndexedVerdict = typeof IndexedVerdict.Type;

/** The Projector's verdict index: any verdict Keel issued, by its id alone. */
export class Verdicts extends Context.Service<
  Verdicts,
  {
    readonly get: (verdictId: VerdictId) => Effect.Effect<IndexedVerdict, VerdictNotFound>;
  }
>()("keel/Verdicts") {}
