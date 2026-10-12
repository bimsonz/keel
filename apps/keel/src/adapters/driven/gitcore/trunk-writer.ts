import type { CommitSha } from "@keeltown/core/kernel";
import { PushRejected } from "@keeltown/core/domain/integration";
import {
  CodeHost,
  PackTooLarge,
  type RepoRef,
  type SyncOutcome,
  TrunkWriter,
} from "@keeltown/core/ports";
import {
  type GitRemote,
  PackTooLarge as GitPackTooLarge,
  ReceivePackBusy,
  type RelayMove,
  relay,
  relayPack,
  uploadPackBytes,
} from "@keeltown/gitcore";
import { Effect, Layer } from "effect";

export const MAIN = "refs/heads/main";

/** Every trunk-side token lives a minute, minted for the one operation that needs it. */
export const TOKEN_TTL_SECONDS = 60;

/** How many times a target that moved under a relay is read again before the sync gives up. */
const STALE_RETRIES = 3;

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
 * covered lands byte for byte. Tokens are minted per call and never leave
 * this adapter; remotes carry the account id, so neither is ever put in an
 * error or a log.
 */
export const TrunkWriterGitCore = ({ trunk, staging }: { trunk: RepoRef; staging: RepoRef }) =>
  Layer.effect(
    TrunkWriter,
    Effect.gen(function* () {
      const host = yield* CodeHost;

      const remoteOf = (repo: RepoRef, access: "read" | "write") =>
        Effect.gen(function* () {
          const info = yield* host.info(repo);
          const token = yield* host.mintToken(repo, access, TOKEN_TTL_SECONDS);
          return { url: info.remote, token: token.token } satisfies GitRemote;
        });

      const headOf = (repo: RepoRef) =>
        host.head(repo, MAIN).pipe(
          Effect.map((sha): CommitSha | null => sha),
          Effect.catchTag("RefNotFound", () => Effect.succeed(null)),
        );

      const trunkHead = host.head(trunk, MAIN).pipe(Effect.catchTag("RefNotFound", Effect.die));

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

      return TrunkWriter.of({
        head: trunkHead.pipe(Effect.catchTag("RepoNotFound", Effect.die)),
        push: (from, to) =>
          Effect.gen(function* () {
            const source = yield* remoteOf(staging, "read");
            const target = yield* remoteOf(trunk, "write");
            const outcome = yield* Effect.tryPromise({
              try: () => relay(source, target, promotion(from, to)),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause): Effect.Effect<never, PackTooLarge | PushRejected> =>
                cause instanceof ReceivePackBusy
                  ? Effect.fail(new PushRejected({ reason: "busy" }))
                  : tooLarge(trunk)(cause),
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
      });
    }),
  );
