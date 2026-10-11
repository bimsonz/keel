import { PushRejected } from "@keeltown/core/domain/integration";
import { CodeHost, type PackTooLarge, type RepoRef, StagingWriter } from "@keeltown/core/ports";
import { type GitRemote, ReceivePackBusy, relay } from "@keeltown/gitcore";
import { Effect, Layer } from "effect";
import { MAIN, TOKEN_TTL_SECONDS, tooLarge } from "./trunk-writer.ts";

/**
 * StagingWriter over GitCore and the code host: trunk's pack for `to` is
 * relayed into staging with `from` as the explicit old value, so a staging
 * that moved meanwhile refuses it. It reads trunk and writes staging, each
 * with a token minted for the call; neither the tokens nor the remotes, which
 * carry the account id, are ever put in an error or a log.
 */
export const StagingWriterGitCore = ({ trunk, staging }: { trunk: RepoRef; staging: RepoRef }) =>
  Layer.effect(
    StagingWriter,
    Effect.gen(function* () {
      const host = yield* CodeHost;

      const remoteOf = (repo: RepoRef, access: "read" | "write") =>
        Effect.gen(function* () {
          const info = yield* host.info(repo);
          const token = yield* host.mintToken(repo, access, TOKEN_TTL_SECONDS);
          return { url: info.remote, token: token.token } satisfies GitRemote;
        });

      return StagingWriter.of({
        fastForward: (from, to) =>
          Effect.gen(function* () {
            const source = yield* remoteOf(trunk, "read");
            const target = yield* remoteOf(staging, "write");
            const outcome = yield* Effect.tryPromise({
              try: () => relay(source, target, { ref: MAIN, from, to }),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause): Effect.Effect<never, PackTooLarge | PushRejected> =>
                cause instanceof ReceivePackBusy
                  ? Effect.fail(new PushRejected({ reason: "busy" }))
                  : tooLarge(staging)(cause),
              ),
            );
            if (outcome.kind !== "rejected") return outcome.kind;
            // Refused: staging no longer held `from`. Already at `to` (the Trunk's own sync got there first) is done.
            const held = yield* host
              .head(staging, MAIN)
              .pipe(Effect.catchTag("RefNotFound", () => Effect.succeed(undefined)));
            if (held === to) return "unchanged" as const;
            return yield* Effect.fail(new PushRejected({ reason: "stale" }));
          }).pipe(Effect.catchTag("RepoNotFound", Effect.die)),
      });
    }),
  );
