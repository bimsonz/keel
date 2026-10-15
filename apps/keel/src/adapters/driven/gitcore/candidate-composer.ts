import { type BoxCheck, CompositionRefused } from "@keeltown/core/domain/integration";
import { CommitSha } from "@keeltown/core/kernel";
import {
  CandidateComposer,
  type CandidateRequest,
  CodeHost,
  type RepoRef,
} from "@keeltown/core/ports";
import {
  FallbackReader,
  type GitObject,
  type ObjectReader,
  receivePack,
  Refusal,
  type RestackMember,
  restack,
  restackOnTrees,
  type Signature,
  writePack,
  ZERO_OID,
} from "@keeltown/gitcore";
import { Cause, Effect, Layer, Schema } from "effect";
import {
  agentAuthor,
  type CommitSigner,
  type CommitSigningConfig,
  commitSigner,
  keelCommitter,
} from "./commit-signing.ts";

const toCommitSha = Schema.decodeUnknownSync(CommitSha);

/** GitCore in a Lane DO holds a staging token for ten minutes, minted for the one push. */
const TOKEN_TTL_SECONDS = 600;

/** How many times a busy receive-pack is asked again before the compose gives up. */
const BUSY_RETRIES = 3;

const TIER_REASON = "GitCore: a path-level three-way merge per member, one commit each";

/** Why MergeBox composed it: GitCore refused, for its reason, and git's merge-tree did not. */
const boxReason = (refused: CompositionRefused) =>
  `MergeBox: git merge-tree per member, one commit each, where GitCore refused (${refused.reason}${refused.paths.length === 0 ? "" : ` ${refused.paths.join(" ")}`})`;

/**
 * MergeBox as the composer reaches it: the trees of a batch GitCore refused,
 * composed member by member in a box, whose chain of unsigned commits is on
 * staging's `scratch` ref at `tip`. A conflict git finds, a busy gate or a
 * box that fails is CompositionRefused with its reason.
 */
export interface BoxComposer {
  readonly compose: (request: CandidateRequest) => Effect.Effect<
    {
      readonly trees: readonly string[];
      readonly scratch: string;
      readonly tip: string;
      readonly boxCheck: BoxCheck;
    },
    CompositionRefused
  >;
}

/** A repo the composer reads from, released when the compose is done. */
export type OpenObjects = (repo: RepoRef) => Promise<ObjectReader & Disposable>;

/**
 * What gitcore restacks for a request: Keel at `host` as committer at
 * BatchFormed's time, the intent's title as the message, and as author the
 * member's agent, named by the trailers `Keel-Agent` and (once it has one)
 * `Keel-Run` after `Change-Id`. A member with no agent, a probe's, keeps its
 * submitted commit's author, which gitcore reads from the head. Everything
 * comes from the request and its commits, so a recompose gives the same SHAs.
 */
export function restackSpec(
  request: CandidateRequest,
  host: string,
): {
  readonly ref: string;
  readonly committer: Signature;
  readonly members: readonly RestackMember[];
} {
  return {
    ref: request.ref ?? `refs/heads/cand/${request.candidateId}`,
    committer: keelCommitter(host, request.at),
    members: request.members.map((m) => ({
      base: m.base,
      head: m.head,
      message: m.title,
      trailers: [
        ["Change-Id", m.changeId],
        ...(m.agent === undefined ? [] : [["Keel-Agent", m.agent.id] as const]),
        ...(m.agent?.run === undefined ? [] : [["Keel-Run", m.agent.run] as const]),
      ],
      author: m.agent === undefined ? undefined : agentAuthor(m.agent, host),
    })),
  };
}

const key = (repo: RepoRef) => `${repo.namespace}/${repo.name}`;

/** gitcore's restack over staging and each member's workspace, each opened once and released after. */
const restacked = (
  open: OpenObjects,
  request: CandidateRequest,
  members: readonly RestackMember[],
  committer: Signature,
  sign: CommitSigner,
) => {
  const repos = new Map<string, RepoRef>([[key(request.staging), request.staging]]);
  for (const m of request.members) repos.set(key(m.repo), m.repo);
  return Effect.acquireUseRelease(
    Effect.promise(() => Promise.all([...repos.values()].map(open))),
    (readers) =>
      Effect.tryPromise({
        try: () => restack(new FallbackReader(readers), request.base, members, committer, { sign }),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          cause instanceof Refusal
            ? Effect.fail(
                new CompositionRefused({
                  reason: cause.reason,
                  paths: cause.path === "" ? [] : [cause.path],
                }),
              )
            : Effect.die(cause),
        ),
      ),
    (readers) =>
      Effect.sync(() => {
        for (const reader of readers) reader[Symbol.dispose]();
      }),
  );
};

/** The commits restack would sign, over the trees MergeBox composed: each member's head read for its author. */
const restackedOnTrees = (
  open: OpenObjects,
  request: CandidateRequest,
  members: readonly RestackMember[],
  trees: readonly string[],
  committer: Signature,
  sign: CommitSigner,
) => {
  const repos = new Map<string, RepoRef>(request.members.map((m) => [key(m.repo), m.repo]));
  return Effect.acquireUseRelease(
    Effect.promise(() => Promise.all([...repos.values()].map(open))),
    (readers) =>
      Effect.promise(() =>
        restackOnTrees(new FallbackReader(readers), request.base, members, trees, committer, {
          sign,
        }),
      ),
    (readers) =>
      Effect.sync(() => {
        for (const reader of readers) reader[Symbol.dispose]();
      }),
  );
};

/**
 * CandidateComposer at Tier 0: gitcore restacks the batch, reading staging
 * first and then each member's workspace, signs every commit as Keel with the
 * deployment's key, and pushes the candidate's ref to staging as a new ref
 * (the request's `ref`, else the candidate's own). A deployment with no
 * signing key, or one its signers file does not vouch for, is a defect before
 * anything is read: Keel never composes an unsigned commit. A
 * ref already at the composed commit is a retry and is left alone; one at any
 * other commit is a defect, since a candidate composes to one SHA. A merge gitcore refuses is CompositionRefused, which MergeBox
 * takes. The token is minted per push and the remote, which carries the
 * account id, is never put in an error or a log.
 */
export const CandidateComposerGitCore = (open: OpenObjects, signing: CommitSigningConfig) =>
  composer(open, signing, undefined);

/**
 * CandidateComposer in tiers: GitCore first (Tier 0), and every batch it
 * refuses goes to MergeBox (Tier 2). The box composes the trees with git's
 * merge-tree; keel writes the commits over them as GitCore would have,
 * signed with the deployment's key (signing never leaves keel), and pushes
 * those commits alone to the candidate's ref, since the trees and blobs are
 * on staging already. The box's scratch ref is deleted after; a delete that
 * fails is logged and left for the next compose to sweep. What the box
 * refuses is the composition's refusal.
 */
export const CandidateComposerTiered = (
  open: OpenObjects,
  signing: CommitSigningConfig,
  box: BoxComposer,
) => composer(open, signing, box);

/** The candidate from its commits, as either tier answers it. */
const candidate = (
  request: CandidateRequest,
  ref: string,
  commits: readonly { readonly oid: string; readonly tree: string }[],
) => {
  const tip = commits.at(-1);
  if (tip === undefined) return Effect.die(new Error("a batch has no members"));
  return Effect.succeed({
    treeSha: toCommitSha(tip.tree),
    commitSha: toCommitSha(tip.oid),
    commits: request.members.map((m, i) => ({
      changeId: m.changeId,
      sha: toCommitSha(commits[i]?.oid),
    })),
    ref,
  });
};

const composer = (open: OpenObjects, signing: CommitSigningConfig, box: BoxComposer | undefined) =>
  Layer.effect(
    CandidateComposer,
    Effect.gen(function* () {
      const host = yield* CodeHost;
      const signerAt = commitSigner(signing);

      const heldBy = (staging: RepoRef, ref: string) =>
        host.head(staging, ref).pipe(
          Effect.map((sha): string | null => sha),
          Effect.catchTag("RefNotFound", () => Effect.succeed(null)),
          Effect.catchTag("RepoNotFound", Effect.die),
        );

      /** Pushes `ref` → `tip` as a new ref, unless it already holds `tip` (a retry). */
      const pushed = (staging: RepoRef, ref: string, tip: string, objects: readonly GitObject[]) =>
        Effect.gen(function* () {
          const held = yield* heldBy(staging, ref);
          if (held === tip) return "held" as const;
          if (held !== null) return yield* Effect.die(new Error(`${ref} holds another candidate`));
          const info = yield* host.info(staging).pipe(Effect.catchTag("RepoNotFound", Effect.die));
          const token = yield* host
            .mintToken(staging, "write", TOKEN_TTL_SECONDS)
            .pipe(Effect.catchTag("RepoNotFound", Effect.die));
          const remote = { url: info.remote, token: token.token };
          const pack = yield* Effect.promise(() => writePack(objects));
          for (let attempt = 0; attempt <= BUSY_RETRIES; attempt += 1) {
            const outcome = yield* Effect.promise(() =>
              receivePack(remote, [{ ref, old: ZERO_OID, new: tip }], pack),
            );
            if (outcome.kind === "applied") return "pushed" as const;
            // Another push holds staging: back off briefly, then send the same pack again.
            if (outcome.kind === "busy") {
              yield* Effect.sleep(50 * 2 ** attempt);
              continue;
            }
            // A racing compose of the same candidate may have pushed it first.
            if (outcome.kind === "rejected" && (yield* heldBy(staging, ref)) === tip)
              return "held" as const;
            return yield* Effect.die(new Error(`the push of ${ref} was ${outcome.kind}`));
          }
          return yield* Effect.die(new Error(`staging stayed busy for the push of ${ref}`));
        });

      /** Deletes the box's scratch ref; a delete that fails never fails the candidate. */
      const dropScratch = (staging: RepoRef, ref: string, tip: string) =>
        Effect.gen(function* () {
          const info = yield* host.info(staging);
          const token = yield* host.mintToken(staging, "write", TOKEN_TTL_SECONDS);
          const outcome = yield* Effect.promise(() =>
            receivePack(
              { url: info.remote, token: token.token },
              [{ ref, old: tip, new: ZERO_OID }],
              null,
            ),
          );
          if (outcome.kind !== "applied")
            yield* Effect.logWarning(
              `${ref} stays, ${outcome.kind}, until the next compose sweeps it`,
            );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `${ref} stays until the next compose sweeps it: ${Cause.pretty(cause)}`,
            ),
          ),
        );

      return CandidateComposer.of({
        compose: (request) =>
          Effect.gen(function* () {
            const spec = restackSpec(request, signing.host);
            const sign = yield* Effect.promise(() => signerAt(spec.committer.time));
            const tier0 = Effect.gen(function* () {
              const out = yield* restacked(open, request, spec.members, spec.committer, sign);
              const composed = yield* candidate(request, spec.ref, out.commits);
              yield* pushed(request.staging, spec.ref, composed.commitSha, out.objects);
              return {
                ...composed,
                composer: "gitcore" as const,
                tier: 0 as const,
                tierReason: TIER_REASON,
              };
            });
            if (box === undefined || request.gitcoreOnly === true) return yield* tier0;
            return yield* tier0.pipe(
              Effect.catchTag("CompositionRefused", (refused) =>
                Effect.gen(function* () {
                  const boxed = yield* box.compose(request);
                  const out = yield* restackedOnTrees(
                    open,
                    request,
                    spec.members,
                    boxed.trees,
                    spec.committer,
                    sign,
                  );
                  const composed = yield* candidate(request, spec.ref, out.commits);
                  yield* pushed(request.staging, spec.ref, composed.commitSha, out.objects);
                  yield* dropScratch(request.staging, boxed.scratch, boxed.tip);
                  return {
                    ...composed,
                    composer: "mergebox" as const,
                    tier: 2 as const,
                    tierReason: boxReason(refused),
                    boxCheck: boxed.boxCheck,
                  };
                }),
              ),
            );
          }),
      });
    }),
  );
