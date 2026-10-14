import { Context, type Effect } from "effect";
import type { BoxCheck, CompositionRefused } from "../../domain/integration/index.ts";
import type {
  AgentId,
  CandidateId,
  ChangeId,
  CommitSha,
  Instant,
  Tier,
} from "../../domain/kernel/index.ts";
import type { RepoRef } from "./code-host.ts";

/** The agent a change belongs to, as the gate authenticated it: who Keel names as the author of what it lands. */
export interface MemberAgent {
  readonly id: AgentId;
  /** Its given handle, made from its key. An agent enrolled before handles has none and is written by its id. */
  readonly handle?: string | undefined;
  /** The run the change was made in, once runs exist. */
  readonly run?: string | undefined;
}

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
  /**
   * The change's agent, which Keel writes as its commit's author; what the
   * submitted commit said of its own author is kept as a trailer. Absent only
   * for a probe's world, which never lands and keeps its submitted authors.
   */
  readonly agent?: MemberAgent | undefined;
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
  /**
   * The ref the composed tip is pushed to, when not the candidate's own
   * `refs/heads/cand/<candidateId>`. A probe's AB world is no batch, so it
   * never takes a `cand/` ref: it goes to `refs/heads/probe/<conflictId>/ab`.
   */
  readonly ref?: string | undefined;
}

/** A composed candidate: one commit per member, chained in batch order, its ref pushed to staging. */
export interface ComposedCandidate {
  /** The last commit's tree: what the batch is verified on. */
  readonly treeSha: CommitSha;
  /** The last commit, which `ref` points at. */
  readonly commitSha: CommitSha;
  /** Each member's commit, in batch order. */
  readonly commits: readonly { readonly changeId: ChangeId; readonly sha: CommitSha }[];
  /** The ref in staging the tip was pushed to: the request's `ref`, else `refs/heads/cand/<candidateId>`. */
  readonly ref: string;
  readonly composer: "gitcore" | "mergebox";
  readonly tier: Tier;
  readonly tierReason: string;
  /** Set when MergeBox composed it: what its check of the box found. */
  readonly boxCheck?: BoxCheck;
}

/**
 * Restacks queued changes onto trunk: one commit per member, chained in batch
 * order, each signed by Keel as committer at the batch's time, authored by the
 * member's agent at the submitted commit's date, and carrying `Change-Id`,
 * `Keel-Agent`, `Keel-Run` (once runs exist) and `Declared-Author` (the
 * submitted commit's own author text) as trailers; a member with no agent
 * keeps its submitted author. It refuses whenever unsure. Composing a
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
