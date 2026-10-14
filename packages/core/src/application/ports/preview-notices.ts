import { Context, type Effect } from "effect";
import type { DeployTargetName } from "../../domain/delivery/index.ts";
import type { CandidateId, ChangeId, DeploymentId } from "../../domain/kernel/index.ts";

/** Where a change's preview answers, as its agent is told. */
export interface PreviewNotice {
  readonly deploymentId: DeploymentId;
  readonly candidateId: CandidateId;
  readonly target: DeployTargetName;
  readonly url: string;
  readonly aliasUrl?: string;
}

/**
 * Tells a change where its preview answers: its Change DO commits
 * `PreviewDeployed` on the change's stream, which its agent reads in its
 * inbox. A change its object never made is told nothing.
 */
export class PreviewNotices extends Context.Service<
  PreviewNotices,
  { readonly tell: (changeId: ChangeId, notice: PreviewNotice) => Effect.Effect<void> }
>()("keel/PreviewNotices") {}
