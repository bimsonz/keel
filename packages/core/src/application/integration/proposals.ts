import { Effect, Option } from "effect";
import {
  type Change,
  CommitNotOnFork,
  NotAForkOf,
  NotAProposal,
  ProposalEmpty,
} from "../../domain/coordination/index.ts";
import type { ChangeId, CommandActor, CommitSha, ProjectId } from "../../domain/kernel/index.ts";
import { Changes, CodeHost, ProjectNamespaces, ProposalLedger, Trunks } from "../ports/index.ts";
import { projectRepos } from "./project-repos.ts";

/** A proposal from a fork, as the doorway asks for it once the policy let its proposer propose. */
export interface ProposeFromFork {
  /** The project proposed to. */
  readonly upstream: ProjectId;
  /** The fork the commit comes from. */
  readonly fork: ProjectId;
  readonly proposer: CommandActor;
  readonly commit: CommitSha;
  readonly goal: string;
  readonly idempotencyKey: string;
  /** A hash of the request body, so a reused key is told apart from a retry. */
  readonly fingerprint: string;
}

/**
 * Whether `ancestor` is in `fork`'s own trunk history at or below
 * `descendant`, the walk stopped at `stops`: the fork point and each upstream
 * head the fork met, so it never reads the upstream's history a sync merged
 * in. A commit the trunk has never seen holds nothing and is held by nothing.
 */
const forkHolds = (fork: ProjectId, stops: readonly CommitSha[]) => {
  const trunk = projectRepos(fork).trunk;
  return (ancestor: CommitSha, descendant: CommitSha) =>
    Effect.flatMap(CodeHost, (host) =>
      host.isAncestor(trunk, ancestor, descendant, stops).pipe(
        Effect.catchTags({
          RepoNotFound: () => Effect.succeed(false),
          ObjectNotFound: () => Effect.succeed(false),
        }),
      ),
    );
};

/** The namespace a project belongs to: every project proposed to, and every fork, has one. */
const namespaceOf = (projectId: ProjectId) =>
  Effect.flatMap(ProjectNamespaces, (places) => places.byId(projectId)).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(new Error(`project ${projectId} belongs to no namespace`)),
        onSome: (place) => Effect.succeed(place.namespace),
      }),
    ),
  );

/**
 * The base a commit of `fork`'s trunk is proposed on: the trunk must hold the
 * commit (CommitNotOnFork), the base is the upstream head of the newest point
 * where the fork met its upstream that the commit holds, the fork point at the
 * last, and a commit carrying nothing past it is ProposalEmpty. A first
 * proposal and every later commit of it are based by this one rule.
 */
const baseOf = (fork: ProjectId, forkPoint: CommitSha, commit: CommitSha) =>
  Effect.gen(function* () {
    const trunks = yield* Trunks;
    const points = yield* trunks.upstreamPoints(fork);
    const stops = [...new Set([forkPoint, ...points.map((point) => point.upstream)])];
    const holds = forkHolds(fork, stops);
    if (!(yield* holds(commit, yield* trunks.head(fork))))
      return yield* new CommitNotOnFork({ fork, commit });
    let base = forkPoint;
    for (const point of points)
      if (yield* holds(point.at, commit)) {
        base = point.upstream;
        break;
      }
    const touched = yield* (yield* CodeHost)
      .diffTrees(projectRepos(fork).trunk, base, commit)
      .pipe(Effect.orDie);
    if (touched.length === 0) return yield* new ProposalEmpty({ fork, commit, base });
    return base;
  });

/**
 * Proposes a fork's commit to the project it was forked from. In order, each
 * refusal before anything is reserved: the fork's trunk must have started as
 * a fork of `upstream` (NotAForkOf); its trunk must hold the commit, reached
 * from its head without passing the fork point (CommitNotOnFork); the base is
 * the upstream head of the newest point where the fork met `upstream` that
 * the commit holds, the fork point at the last; and a commit carrying nothing
 * past it is ProposalEmpty. The project's ledger then reserves the change id
 * for the proposer's key, capping what they have open there, and the change's
 * object makes the proposal: a retry reaches the same change. What it copies
 * in counts against the fork's namespace, the proposer's side: a stranger's
 * proposals never spend the repo bytes of the project they are proposed to.
 */
export const proposeFromFork = Effect.fn("integration/proposeFromFork")(function* (
  input: ProposeFromFork,
) {
  const trunks = yield* Trunks;
  const origin = Option.getOrUndefined(yield* trunks.origin(input.fork));
  if (origin?.kind !== "forked" || origin.project !== input.upstream)
    return yield* new NotAForkOf({ fork: input.fork, upstream: input.upstream });
  const trunk = projectRepos(input.fork).trunk;
  const base = yield* baseOf(input.fork, origin.commit, input.commit);
  const namespace = yield* namespaceOf(input.fork);
  const changeId = yield* (yield* ProposalLedger).reserve(input.upstream, {
    proposer: input.proposer,
    idempotencyKey: input.idempotencyKey,
    fingerprint: input.fingerprint,
  });
  const proposed: Change = yield* (yield* Changes).propose(changeId, {
    changeId,
    projectId: input.upstream,
    fork: { projectId: input.fork, trunk },
    proposer: input.proposer,
    commit: input.commit,
    base,
    namespace,
    goal: input.goal,
    idempotencyKey: input.idempotencyKey,
    fingerprint: input.fingerprint,
  });
  return proposed;
});

/** A proposal moved to another commit, as the doorway asks for it once the policy found its proposer asking. */
export interface UpdateFromFork {
  /** The project the proposal is to, as the doorway authorised it. */
  readonly upstream: ProjectId;
  readonly changeId: ChangeId;
  readonly proposer: CommandActor;
  readonly commit: CommitSha;
  readonly note?: string | undefined;
  readonly idempotencyKey: string;
}

/**
 * Moves a proposal to another commit of its own fork: one the fork's trunk
 * holds, as `proposeFromFork` asks of a first commit (CommitNotOnFork
 * otherwise). The change's object copies it in and submits it, with no
 * approval: it is checked, and waits for one, again.
 */
export const updateFromFork = Effect.fn("integration/updateFromFork")(function* (
  input: UpdateFromFork,
) {
  const changes = yield* Changes;
  const { change } = yield* changes.get(input.changeId);
  if (change.proposal === undefined) return yield* new NotAProposal({ changeId: input.changeId });
  const fork = change.proposal.fork;
  const trunks = yield* Trunks;
  const origin = Option.getOrUndefined(yield* trunks.origin(fork));
  if (origin?.kind !== "forked") return yield* new NotAForkOf({ fork, upstream: input.upstream });
  const base = yield* baseOf(fork, origin.commit, input.commit);
  const moved: Change = yield* changes.updateProposal(input.changeId, {
    proposer: input.proposer,
    projectId: input.upstream,
    fork: { projectId: fork, trunk: projectRepos(fork).trunk },
    commit: input.commit,
    base,
    ...(input.note === undefined ? {} : { note: input.note }),
    namespace: yield* namespaceOf(fork),
    idempotencyKey: input.idempotencyKey,
  });
  return moved;
});
