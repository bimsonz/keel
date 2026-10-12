import { projectRepos } from "@keeltown/core/application/integration";
import type { ProjectId } from "@keeltown/core/kernel";
import { PushRejected } from "@keeltown/core/domain/integration";
import {
  CodeHost,
  type PackTooLarge,
  type RepoRef,
  type SyncOutcome,
  WorkspaceRefresher,
} from "@keeltown/core/ports";
import { type GitRemote, ReceivePackBusy, relay } from "@keeltown/gitcore";
import { Effect, Layer } from "effect";
import { MAIN, TOKEN_TTL_SECONDS, tooLarge } from "./trunk-writer.ts";

/**
 * WorkspaceRefresher over GitCore and the code host: the project's trunk pack
 * for the head is relayed into the workspace's main, with the commit the pool
 * names as the explicit old value and the only have, so a main that is
 * anywhere else refuses it. A refused push is `stale` at once: the pool reads
 * main back and decides, so nothing is read or retried here. It reads trunk
 * and writes the workspace, each with a token minted for the call; neither
 * the tokens nor the remotes, which carry the account id, are ever put in an
 * error or a log. `trunkOf` finds a project's trunk (`projectRepos` unless a
 * test names its own).
 */
export const WorkspaceRefresherGitCore = (
  trunkOf: (projectId: ProjectId) => RepoRef = (projectId) => projectRepos(projectId).trunk,
) =>
  Layer.effect(
    WorkspaceRefresher,
    Effect.gen(function* () {
      const host = yield* CodeHost;

      const remoteOf = (repo: RepoRef, access: "read" | "write") =>
        Effect.gen(function* () {
          const info = yield* host.info(repo);
          const token = yield* host.mintToken(repo, access, TOKEN_TTL_SECONDS);
          return { url: info.remote, token: token.token } satisfies GitRemote;
        });

      return WorkspaceRefresher.of({
        advance: (projectId, workspace, from, to) =>
          Effect.gen(function* () {
            if (from === to) return "unchanged" satisfies SyncOutcome;
            // The workspace first: one that is gone costs trunk no token.
            const target = yield* remoteOf(workspace, "write");
            const source = yield* remoteOf(trunkOf(projectId), "read").pipe(
              Effect.catchTag("RepoNotFound", Effect.die),
            );
            const outcome = yield* Effect.tryPromise({
              try: () => relay(source, target, { ref: MAIN, from, to }),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause): Effect.Effect<never, PackTooLarge | PushRejected> =>
                cause instanceof ReceivePackBusy
                  ? Effect.fail(new PushRejected({ reason: "busy" }))
                  : tooLarge(workspace)(cause),
              ),
            );
            if (outcome.kind === "rejected")
              return yield* Effect.fail(new PushRejected({ reason: "stale" }));
            return outcome.kind satisfies SyncOutcome;
          }),
      });
    }),
  );
