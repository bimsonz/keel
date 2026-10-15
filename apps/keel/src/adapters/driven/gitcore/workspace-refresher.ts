import { gitRemote } from "./remote.ts";
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
import { ReceivePackBusy, relay, RelayNotForward } from "@keeltown/gitcore";
import { Effect, Layer } from "effect";
import { MAIN, TOKEN_TTL_SECONDS, tooLarge } from "./trunk-writer.ts";

/**
 * How long one request of a relay of trunk's whole history may run, the
 * pool's `FILL_MS`: keel's own history relayed in 101 s on 15 Oct, against
 * the 120 s every other git request is given.
 */
export const WHOLE_RELAY_MS = 300_000;

/**
 * WorkspaceRefresher over GitCore and the code host: the project's trunk pack
 * for the head is relayed into the workspace's main, with the commit the pool
 * names as the explicit old value and the only have, so a main that is
 * anywhere else refuses it. A refused push is `stale` at once: the pool reads
 * main back and decides, so nothing is read or retried here. So is a head
 * that is behind the commit the pool names: GitCore's relay sends nothing
 * for it and pushes nothing, so a workspace is never taken back. It reads trunk
 * and writes the workspace, each with a token minted for the call; neither
 * the tokens nor the remotes, which carry the account id, are ever put in an
 * error or a log. `trunkOf` finds a project's trunk (`projectRepos` unless a
 * test names its own). A relay of trunk's whole history into an empty
 * workspace is bounded by `wholeMs` a request rather than the git deadline.
 */
export const WorkspaceRefresherGitCore = (
  trunkOf: (projectId: ProjectId) => RepoRef = (projectId) => projectRepos(projectId).trunk,
  wholeMs: number = WHOLE_RELAY_MS,
) =>
  Layer.effect(
    WorkspaceRefresher,
    Effect.gen(function* () {
      const host = yield* CodeHost;

      const remoteOf = (repo: RepoRef, access: "read" | "write", deadlineMs?: number) =>
        Effect.gen(function* () {
          const info = yield* host.info(repo);
          const token = yield* host.mintToken(repo, access, TOKEN_TTL_SECONDS);
          const remote = gitRemote(info.remote, token.token);
          return deadlineMs === undefined ? remote : { ...remote, deadlineMs };
        });

      return WorkspaceRefresher.of({
        advance: (projectId, workspace, from, to) =>
          Effect.gen(function* () {
            if (from === to) return "unchanged" satisfies SyncOutcome;
            // Trunk's whole history, into a workspace made empty, outlasts the git deadline: keel's took 101 s.
            const bound = from === null ? wholeMs : undefined;
            // The workspace first: one that is gone costs trunk no token.
            const target = yield* remoteOf(workspace, "write", bound);
            const source = yield* remoteOf(trunkOf(projectId), "read", bound).pipe(
              Effect.catchTag("RepoNotFound", Effect.die),
            );
            const outcome = yield* Effect.tryPromise({
              try: () => relay(source, target, { ref: MAIN, from, to }),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause): Effect.Effect<never, PackTooLarge | PushRejected> =>
                cause instanceof ReceivePackBusy
                  ? Effect.fail(new PushRejected({ reason: "busy" }))
                  : cause instanceof RelayNotForward
                    ? Effect.fail(new PushRejected({ reason: "stale" }))
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
