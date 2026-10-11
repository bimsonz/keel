import { Context, type Effect } from "effect";
import type { CompositionRefused } from "../../domain/integration/index.ts";
import type { CandidateId, ChangeId, CommitSha, Instant, Tier } from "../../domain/kernel/index.ts";
import type { RepoRef } from "./code-host.ts";

/** One queued change: where its commits live, the trunk commit it was made on, and what it lands as. */
export interface CandidateMember {
  readonly changeId: ChangeId;
  /** The change's workspace, which holds its head. */
  readonly repo: RepoRef;
  /** Its workspace's head when granted: the base its change is merged against. */
  readonly base: CommitSha;
  readonly head: CommitSha;
  /** The intent's title: its commit's message. */
  readonly title: string;
}

export interface CandidateRequest {
  readonly candidateId: CandidateId;
  /** The project's staging repo, which holds trunk and receives the candidate's ref. */
  readonly staging: RepoRef;
  /** The trunk commit the batch is composed onto. */
  readonly base: CommitSha;
  /** BatchFormed's time: every commit's committer time, so a recompose gives the same SHAs. */
  readonly at: Instant;
  readonly members: readonly CandidateMember[];
}

/** A composed candidate: one commit per member, chained in batch order, its ref pushed to staging. */
export interface ComposedCandidate {
  /** The last commit's tree: what the batch is verified on. */
  readonly treeSha: CommitSha;
  /** The last commit, which `ref` points at. */
  readonly commitSha: CommitSha;
  /** Each member's commit, in batch order. */
  readonly commits: readonly { readonly changeId: ChangeId; readonly sha: CommitSha }[];
  /** `refs/heads/cand/<candidateId>` in staging. */
  readonly ref: string;
  readonly composer: "gitcore" | "mergebox";
  readonly tier: Tier;
  readonly tierReason: string;
}

/**
 * Restacks queued changes onto trunk: one commit per member, chained in batch
 * order, each with its `Change-Id` trailer, its submitted commit's author and
 * Keel as committer at the batch's time, refusing whenever unsure. Composing a
 * candidate again gives the same commits and leaves its ref as it was.
 */
export class CandidateComposer extends Context.Service<
  CandidateComposer,
  {
    readonly compose: (
      request: CandidateRequest,
    ) => Effect.Effect<ComposedCandidate, CompositionRefused>;
  }
>()("keel/CandidateComposer") {}
