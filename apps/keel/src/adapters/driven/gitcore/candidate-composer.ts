import { CompositionRefused } from "@keeltown/core/domain/integration";
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
  type Signature,
  writePack,
  ZERO_OID,
} from "@keeltown/gitcore";
import { Effect, Layer, Schema } from "effect";

const toCommitSha = Schema.decodeUnknownSync(CommitSha);

/** GitCore in a Lane DO holds a staging token for ten minutes, minted for the one push. */
const TOKEN_TTL_SECONDS = 600;

/** How many times a busy receive-pack is asked again before the compose gives up. */
const BUSY_RETRIES = 3;

const TIER_REASON = "GitCore: a path-level three-way merge per member, one commit each";

/** A repo the composer reads from, released when the compose is done. */
export type OpenObjects = (repo: RepoRef) => Promise<ObjectReader & Disposable>;

/**
 * What gitcore restacks for a request: Keel as committer at BatchFormed's
 * time, the intent's title as the message and the change's `Change-Id`
 * trailer. Each commit keeps its submitted commit's author, which gitcore
 * reads from the head. Everything comes from the request and its commits, so
 * a recompose gives the same SHAs.
 */
export function restackSpec(request: CandidateRequest): {
  readonly ref: string;
  readonly committer: Signature;
  readonly members: readonly RestackMember[];
} {
  const time = Math.floor(request.at / 1000);
  return {
    ref: request.ref ?? `refs/heads/cand/${request.candidateId}`,
    committer: { name: "Keel", email: "keel@keel.invalid", time },
    members: request.members.map((m) => ({
      base: m.base,
      head: m.head,
      message: m.title,
      trailers: [["Change-Id", m.changeId]],
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
) => {
  const repos = new Map<string, RepoRef>([[key(request.staging), request.staging]]);
  for (const m of request.members) repos.set(key(m.repo), m.repo);
  return Effect.acquireUseRelease(
    Effect.promise(() => Promise.all([...repos.values()].map(open))),
    (readers) =>
      Effect.tryPromise({
        try: () => restack(new FallbackReader(readers), request.base, members, committer),
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

/**
 * CandidateComposer at Tier 0: gitcore restacks the batch, reading staging
 * first and then each member's workspace, and pushes the candidate's ref to
 * staging as a new ref (the request's `ref`, else the candidate's own). A
 * ref already at the composed commit is a retry and is left alone; one at any
 * other commit is a defect, since a candidate composes to one SHA. A merge gitcore refuses is CompositionRefused, which MergeBox
 * takes. The token is minted per push and the remote, which carries the
 * account id, is never put in an error or a log.
 */
export const CandidateComposerGitCore = (open: OpenObjects) =>
  Layer.effect(
    CandidateComposer,
    Effect.gen(function* () {
      const host = yield* CodeHost;

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

      return CandidateComposer.of({
        compose: (request) =>
          Effect.gen(function* () {
            const spec = restackSpec(request);
            const out = yield* restacked(open, request, spec.members, spec.committer);
            const tip = out.commits.at(-1);
            if (tip === undefined) return yield* Effect.die(new Error("a batch has no members"));
            yield* pushed(request.staging, spec.ref, tip.oid, out.objects);
            return {
              treeSha: toCommitSha(tip.tree),
              commitSha: toCommitSha(tip.oid),
              commits: request.members.map((m, i) => ({
                changeId: m.changeId,
                sha: toCommitSha(out.commits[i]?.oid),
              })),
              ref: spec.ref,
              composer: "gitcore" as const,
              tier: 0 as const,
              tierReason: TIER_REASON,
            };
          }),
      });
    }),
  );
