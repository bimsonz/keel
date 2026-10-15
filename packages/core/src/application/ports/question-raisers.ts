import { Context, type Effect } from "effect";
import type { ConflictId } from "../../domain/kernel/index.ts";

/**
 * The objects that raise a namespace's questions, asked to check one again.
 * The namespace's object asks a question's raiser, by the address it raised
 * the question from, whether anything is left to rule on; a raiser with
 * nothing left withdraws the question through `HumanGate`. Asking again is
 * harmless: a question already withdrawn or answered stays as it is.
 */
export class QuestionRaisers extends Context.Service<
  QuestionRaisers,
  {
    readonly recheck: (raisedBy: string, conflictId: ConflictId) => Effect.Effect<void>;
  }
>()("keel/QuestionRaisers") {}
