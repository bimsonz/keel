import type { CommitSha } from "@keeltown/core/kernel";
import {
  CodeHost,
  PackTooLarge,
  type RepoRef,
  type SyncOutcome,
  TrunkWriter,
} from "@keeltown/core/ports";
import { type GitRemote, PackTooLarge as GitPackTooLarge, relay } from "@keeltown/gitcore";
import { Effect, Layer } from "effect";

const MAIN = "refs/heads/main";

/** Every trunk-side token lives a minute, minted for the one operation that needs it. */
const TOKEN_TTL_SECONDS = 60;

/** How many times a target that moved under a relay is read again before the sync gives up. */
const STALE_RETRIES = 3;

/**
 * TrunkWriter over GitCore and the code host: tokens are minted per call and
 * never leave this adapter; remotes carry the account id, so neither is ever
 * put in an error or a log.
 */
export const TrunkWriterGitCore = (trunk: RepoRef) =>
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

      /** One target, relayed until it holds `head`, or until it has moved under us too often. */
      const syncOne = (source: GitRemote, head: CommitSha, target: RepoRef) =>
        Effect.gen(function* () {
          const remote = yield* remoteOf(target, "write");
          for (let attempt = 0; attempt <= STALE_RETRIES; attempt += 1) {
            const from = yield* headOf(target);
            const outcome = yield* Effect.tryPromise({
              try: () => relay(source, remote, { ref: MAIN, from, to: head }),
              catch: (cause) => cause,
            }).pipe(
              // Over the cap is the one expected failure; anything else from git is a defect.
              Effect.catch((cause) =>
                cause instanceof GitPackTooLarge
                  ? Effect.fail(
                      new PackTooLarge({
                        repo: { namespace: target.namespace, name: target.name },
                        bytes: cause.bytes,
                        limit: cause.limit,
                      }),
                    )
                  : Effect.die(cause),
              ),
            );
            if (outcome.kind !== "rejected") return outcome.kind satisfies SyncOutcome;
          }
          return yield* Effect.die(
            new Error(`${target.namespace}/${target.name} kept moving during sync`),
          );
        });

      return TrunkWriter.of({
        head: trunkHead.pipe(Effect.catchTag("RepoNotFound", Effect.die)),
        push: () => Effect.die(new Error("TrunkWriter.push arrives with C1.2's TrunkWriter step")),
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
