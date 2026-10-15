import { gitRemote } from "./remote.ts";
import { CommitSha } from "@keeltown/core/kernel";
import { PushRejected } from "@keeltown/core/domain/integration";
import {
  CodeHost,
  PackTooLarge,
  type RepoRef,
  type SyncOutcome,
  type TakenTrunk,
  TrunkWriter,
  UpstreamUnreachable,
} from "@keeltown/core/ports";
import {
  advertisement,
  type GitObject,
  type GitRemote,
  PackTooLarge as GitPackTooLarge,
  receivePack,
  ReceivePackBusy,
  type RelayMove,
  relay,
  relayPack,
  relaySend,
  rootCommit,
  uploadPackBytes,
  writePack,
  ZERO_OID,
} from "@keeltown/gitcore";
import { Effect, Layer, Schema } from "effect";
import { type CommitSigningConfig, commitSigner, keelCommitter } from "./commit-signing.ts";

export const MAIN = "refs/heads/main";

/**
 * Where a sync from upstream holds upstream's history in trunk until main is
 * moved to it: a branch, as staging's candidates are, so the code host takes
 * it as it takes any push. It is deleted once the sync is resolved.
 */
export const UPSTREAM_REF = "refs/heads/keel/upstream-sync";

/** Every trunk-side token lives a minute, minted for the one operation that needs it. */
export const TOKEN_TTL_SECONDS = 60;

/** How many times a target that moved under a relay is read again before the sync gives up. */
const STALE_RETRIES = 3;

/** How many times making trunk's main is sent again while trunk answers busy. */
const BUSY_RETRIES = 3;

const toCommitSha = Schema.decodeUnknownSync(CommitSha);

/** What Keel's first commit to an empty project holds: a README that names the project. */
export const seedSpec = (name: string) => ({
  path: "README.md",
  content: `# ${name}\n`,
  message: `Start ${name}`,
});

/** Over the cap is the one expected failure of a relay; anything else from git is a defect. */
export const tooLarge =
  (target: RepoRef) =>
  (cause: unknown): Effect.Effect<never, PackTooLarge> =>
    cause instanceof GitPackTooLarge
      ? Effect.fail(
          new PackTooLarge({
            repo: { namespace: target.namespace, name: target.name },
            bytes: cause.bytes,
            limit: cause.limit,
          }),
        )
      : Effect.die(cause);

/**
 * TrunkWriter over GitCore and the code host. A promotion relays the
 * candidate's own pack from staging into trunk, so the commit the verdict
 * covered lands byte for byte: the pack is fetched once, admitted on its
 * length, and that very pack is sent. The first commit of an empty project is
 * Keel's own, signed with the deployment's key: no key, or one the signers
 * file does not vouch for at that time, is a defect before anything is
 * pushed. Tokens are minted per call and never leave this adapter; remotes
 * carry the account id, so neither is ever put in an error or a log.
 */
export const TrunkWriterGitCore = (
  { trunk, staging }: { trunk: RepoRef; staging: RepoRef },
  signing: CommitSigningConfig,
) =>
  Layer.effect(
    TrunkWriter,
    Effect.gen(function* () {
      const host = yield* CodeHost;
      const signerAt = commitSigner(signing);

      const remoteOf = (repo: RepoRef, access: "read" | "write") =>
        Effect.gen(function* () {
          const info = yield* host.info(repo);
          const token = yield* host.mintToken(repo, access, TOKEN_TTL_SECONDS);
          return gitRemote(info.remote, token.token);
        });

      const headOf = (repo: RepoRef) =>
        host.head(repo, MAIN).pipe(
          Effect.map((sha): CommitSha | null => sha),
          Effect.catchTag("RefNotFound", () => Effect.succeed(null)),
        );

      const trunkHead = host.head(trunk, MAIN).pipe(Effect.catchTag("RefNotFound", Effect.die));

      /** Trunk's side ref of a sync from upstream, or null when none is open. */
      const sideHead = host.head(trunk, UPSTREAM_REF).pipe(
        Effect.map((sha): CommitSha | null => sha),
        Effect.catchTags({ RefNotFound: () => Effect.succeed(null), RepoNotFound: Effect.die }),
      );

      /** Trunk's main, or null before it has one. Trunk's own repo missing is a defect, never a source's. */
      const ownHead = headOf(trunk).pipe(Effect.catchTag("RepoNotFound", Effect.die));

      /** A promotion's move, built once so that weighing it and pushing it ask staging for the same pack. */
      const promotion = (from: CommitSha, to: CommitSha): RelayMove => ({ ref: MAIN, from, to });

      /** One target, relayed until it holds `head`, or until it has moved under us too often. */
      const syncOne = (source: GitRemote, head: CommitSha, target: RepoRef) =>
        Effect.gen(function* () {
          const remote = yield* remoteOf(target, "write");
          for (let attempt = 0; attempt <= STALE_RETRIES; attempt += 1) {
            const from = yield* headOf(target);
            const outcome = yield* Effect.tryPromise({
              try: () => relay(source, remote, { ref: MAIN, from, to: head }),
              catch: (cause) => cause,
            }).pipe(Effect.catch(tooLarge(target)));
            if (outcome.kind !== "rejected") return outcome.kind satisfies SyncOutcome;
          }
          return yield* Effect.die(
            new Error(`${target.namespace}/${target.name} kept moving during sync`),
          );
        });

      /**
       * Makes trunk's main at `tip` as a new ref, sending `objects` (none
       * for a commit trunk already holds). A main already at `tip` is a
       * retry; a main anywhere else is a defect, and is never moved.
       */
      const makeMain = (tip: CommitSha, objects: readonly GitObject[]) =>
        Effect.gen(function* () {
          const held = yield* headOf(trunk);
          if (held === tip) return "held" as const;
          if (held !== null)
            return yield* Effect.die(new Error("trunk already has a main, at another commit"));
          const target = yield* remoteOf(trunk, "write");
          const pack = yield* Effect.promise(() => writePack(objects));
          for (let attempt = 0; attempt <= BUSY_RETRIES; attempt += 1) {
            const outcome = yield* Effect.promise(() =>
              receivePack(target, [{ ref: MAIN, old: ZERO_OID, new: tip }], pack),
            );
            if (outcome.kind === "applied") return "made" as const;
            // Another push holds trunk: back off briefly, then send the same pack again.
            if (outcome.kind === "busy") {
              yield* Effect.sleep(50 * 2 ** attempt);
              continue;
            }
            // A racing attempt of the same bootstrap may have made it first.
            if (outcome.kind === "rejected" && (yield* headOf(trunk)) === tip)
              return "held" as const;
            return yield* Effect.die(new Error(`making trunk's main was ${outcome.kind}`));
          }
          return yield* Effect.die(new Error("trunk stayed busy while its main was made"));
        }).pipe(Effect.catchTag("RepoNotFound", Effect.die));

      return TrunkWriter.of({
        head: trunkHead.pipe(Effect.catchTag("RepoNotFound", Effect.die)),
        adopt: (commit) => Effect.asVoid(makeMain(commit, [])),
        seed: (name, at) =>
          Effect.gen(function* () {
            const keel = keelCommitter(signing.host, at);
            const sign = yield* Effect.promise(() => signerAt(keel.time));
            const root = yield* Effect.promise(() =>
              rootCommit({ ...seedSpec(name), author: keel, committer: keel, sign }),
            );
            const tip = toCommitSha(root.oid);
            yield* makeMain(tip, root.objects);
            return tip;
          }),
        take: (source) =>
          Effect.gen(function* () {
            // A main that exists is never moved: a retry answers it, whatever the source holds now.
            const held = yield* ownHead;
            if (held !== null) return { head: held } satisfies TakenTrunk;
            const tip = yield* host
              .head(source, MAIN)
              .pipe(Effect.catchTag("RefNotFound", Effect.die));
            const from = yield* remoteOf(source, "read");
            const move = { ref: MAIN, from: null, to: tip };
            const pack = yield* Effect.tryPromise({
              try: () => relayPack(from, move),
              catch: (cause) => cause,
            }).pipe(Effect.catch(tooLarge(source)));
            const target = yield* remoteOf(trunk, "write").pipe(
              Effect.catchTag("RepoNotFound", Effect.die),
            );
            const outcome = yield* Effect.tryPromise({
              try: () => relaySend(target, move, pack),
              catch: (cause) => cause,
            }).pipe(Effect.orDie);
            if (outcome.kind !== "rejected")
              return { head: tip, bytes: pack.length } satisfies TakenTrunk;
            // A racing attempt of the same bootstrap made main first: what trunk holds is the answer.
            const raced = yield* ownHead;
            if (raced === null)
              return yield* Effect.die(new Error("trunk refused its source's history"));
            return { head: raced } satisfies TakenTrunk;
          }),
        push: (from, to, admit) =>
          Effect.gen(function* () {
            const move = promotion(from, to);
            const source = yield* remoteOf(staging, "read");
            const pack = yield* Effect.tryPromise({
              try: () => relayPack(source, move),
              catch: (cause) => cause,
            }).pipe(Effect.catch(tooLarge(trunk)));
            // Admitted on the pack in hand, before trunk is asked for anything: a refusal mints no write token.
            yield* admit(pack.length);
            const target = yield* remoteOf(trunk, "write");
            const outcome = yield* Effect.tryPromise({
              try: () => relaySend(target, move, pack),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause): Effect.Effect<never, PushRejected> =>
                cause instanceof ReceivePackBusy
                  ? Effect.fail(new PushRejected({ reason: "busy" }))
                  : Effect.die(cause),
              ),
            );
            // A relay is never `unchanged` here: a promotion's `to` is never its `from`.
            if (outcome.kind === "rejected")
              yield* Effect.fail(new PushRejected({ reason: "stale" }));
          }).pipe(Effect.catchTag("RepoNotFound", Effect.die)),
        packBytes: (from, to) =>
          Effect.gen(function* () {
            const source = yield* remoteOf(staging, "read");
            const pack = yield* Effect.tryPromise({
              try: () => relayPack(source, promotion(from, to)),
              catch: (cause) => cause,
            }).pipe(Effect.catch(tooLarge(trunk)));
            return pack.length;
          }).pipe(Effect.catchTag("RepoNotFound", Effect.die)),
        historyBytes: (at) =>
          Effect.gen(function* () {
            const source = yield* remoteOf(trunk, "read");
            return yield* Effect.promise(() => uploadPackBytes(source, [at], []));
          }).pipe(Effect.catchTag("RepoNotFound", Effect.die)),
        sync: (targets) =>
          Effect.gen(function* () {
            const head = yield* trunkHead;
            const source = yield* remoteOf(trunk, "read");
            const outcomes: SyncOutcome[] = [];
            for (const target of targets) outcomes.push(yield* syncOne(source, head, target));
            return { head, outcomes };
          }),
        // An upstream is someone else's public repository: it is read with no credential, as the import's relay reads it.
        upstreamHead: (upstream) =>
          Effect.tryPromise({
            try: () => advertisement(gitRemote(upstream.url)),
            catch: () => new UpstreamUnreachable({ ...upstream, reason: "unreachable" }),
          }).pipe(
            Effect.map((advertised) => {
              const head = advertised.refs.get(upstream.ref);
              return head === undefined ? undefined : toCommitSha(head);
            }),
          ),
        fetchUpstream: (upstream, to, haves) =>
          Effect.gen(function* () {
            const move: RelayMove = { ref: UPSTREAM_REF, from: null, to, haves };
            const pack = yield* Effect.tryPromise({
              try: () => relayPack(gitRemote(upstream.url), move),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause): Effect.Effect<never, PackTooLarge | UpstreamUnreachable> =>
                cause instanceof GitPackTooLarge
                  ? tooLarge(trunk)(cause)
                  : Effect.fail(new UpstreamUnreachable({ ...upstream, reason: "unreachable" })),
              ),
            );
            const target = yield* remoteOf(trunk, "write").pipe(
              Effect.catchTag("RepoNotFound", Effect.die),
            );
            // The side ref may hold an earlier sync's fetch: it is moved from whatever it holds, read again if it moved.
            for (let attempt = 0; attempt <= STALE_RETRIES; attempt += 1) {
              const held = yield* sideHead;
              const outcome = yield* Effect.tryPromise({
                try: () => relaySend(target, { ...move, from: held }, pack),
                catch: (cause) => cause,
              }).pipe(Effect.orDie);
              if (outcome.kind !== "rejected") return pack.length;
            }
            return yield* Effect.die(new Error("trunk's upstream ref kept moving during a sync"));
          }),
        descends: (from, to, stopAt) => host.isAncestor(trunk, from, to, stopAt).pipe(Effect.orDie),
        fastForward: (from, to) =>
          Effect.gen(function* () {
            const target = yield* remoteOf(trunk, "write").pipe(
              Effect.catchTag("RepoNotFound", Effect.die),
            );
            // `to` is in trunk already, under the side ref: the push sends no object.
            const pack = yield* Effect.promise(() => writePack([]));
            for (let attempt = 0; attempt <= BUSY_RETRIES; attempt += 1) {
              const outcome = yield* Effect.promise(() =>
                receivePack(target, [{ ref: MAIN, old: from, new: to }], pack),
              );
              if (outcome.kind === "applied") return "moved" as const;
              if (outcome.kind === "rejected")
                return yield* Effect.fail(new PushRejected({ reason: "stale" }));
              if (outcome.kind === "failed")
                return yield* Effect.die(
                  new Error(`moving trunk's main was refused: ${outcome.message}`),
                );
              yield* Effect.sleep(50 * 2 ** attempt);
            }
            return yield* Effect.fail(new PushRejected({ reason: "busy" }));
          }).pipe(Effect.asVoid),
        dropUpstream: Effect.gen(function* () {
          const held = yield* sideHead;
          if (held === null) return;
          const target = yield* remoteOf(trunk, "write").pipe(
            Effect.catchTag("RepoNotFound", Effect.die),
          );
          // A side ref left behind holds nothing main needs: the next sync moves it from what it holds.
          yield* Effect.promise(() =>
            receivePack(target, [{ ref: UPSTREAM_REF, old: held, new: ZERO_OID }], null),
          );
        }),
      });
    }),
  );
