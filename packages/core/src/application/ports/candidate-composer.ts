import { Context, type Effect } from "effect";
import type { CompositionRefused } from "../../domain/integration/index.ts";
import type { ChangeId, CommitSha, TierChoice } from "../../domain/kernel/index.ts";

export interface ComposedTree {
  readonly treeSha: CommitSha;
  readonly tier: TierChoice;
}

/** Composes trunk plus queued changes into one candidate tree, refusing whenever unsure. */
export class CandidateComposer extends Context.Service<
  CandidateComposer,
  {
    readonly compose: (
      base: CommitSha,
      members: readonly { readonly changeId: ChangeId; readonly commit: CommitSha }[],
    ) => Effect.Effect<ComposedTree, CompositionRefused>;
  }
>()("keel/CandidateComposer") {}
