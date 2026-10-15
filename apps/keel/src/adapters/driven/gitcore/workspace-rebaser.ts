import { gitRemote } from "./remote.ts";
import { projectRepos } from "@keeltown/core/application/integration";
import type { CommitSha, ProjectId } from "@keeltown/core/kernel";
import { PushRejected } from "@keeltown/core/domain/integration";
import {
  CodeHost,
  KEEL_TRUNK_REF,
  type PackTooLarge,
  type RepoRef,
  type SyncOutcome,
  WorkspaceRebaser,
} from "@keeltown/core/ports";
import { ReceivePackBusy, relay } from "@keeltown/gitcore";
import { Effect, Layer } from "effect";
import { TOKEN_TTL_SECONDS, tooLarge } from "./trunk-writer.ts";

/** How many times a `keel/trunk` that moved under a relay is read again before the push gives up. */
const STALE_RETRIES = 3;

/**
 * WorkspaceRebaser over GitCore and the code host: the project's trunk pack
 * for the head is relayed into the workspace's `keel/trunk`, with that ref's
 * current value as the explicit old one, so a ref that moved meanwhile
 * refuses it and is read again. It reads trunk and writes the workspace, each
 * with a token minted for the call; neither the tokens nor the remotes, which
 * carry the account id, are ever put in an error or a log. `trunkOf` finds a
 * project's trunk (`projectRepos` unless a test names its own).
 */
export const WorkspaceRebaserGitCore = (
  trunkOf: (projectId: ProjectId) => RepoRef = (projectId) => projectRepos(projectId).trunk,
) =>
  Layer.effect(
    WorkspaceRebaser,
    Effect.gen(function* () {
      const host = yield* CodeHost;

      const remoteOf = (repo: RepoRef, access: "read" | "write") =>
        Effect.gen(function* () {
          const info = yield* host.info(repo);
          const token = yield* host.mintToken(repo, access, TOKEN_TTL_SECONDS);
          return gitRemote(info.remote, token.token);
        });

      const heldBy = (workspace: RepoRef) =>
        host.head(workspace, KEEL_TRUNK_REF).pipe(
          Effect.map((sha): CommitSha | null => sha),
          Effect.catchTag("RefNotFound", () => Effect.succeed(null)),
        );

      return WorkspaceRebaser.of({
        pushTrunk: (projectId, workspace, base, head) =>
          Effect.gen(function* () {
            for (let attempt = 0; attempt <= STALE_RETRIES; attempt += 1) {
              const held = yield* heldBy(workspace);
              if (held === head) return "unchanged" satisfies SyncOutcome;
              const source = yield* remoteOf(trunkOf(projectId), "read").pipe(
                Effect.catchTag("RepoNotFound", Effect.die),
              );
              const target = yield* remoteOf(workspace, "write");
              const outcome = yield* Effect.tryPromise({
                try: () =>
                  relay(source, target, {
                    ref: KEEL_TRUNK_REF,
                    from: held,
                    to: head,
                    // The workspace holds the change's base, and the trunk it was last given.
                    haves: held === null ? [base] : [base, held],
                  }),
                catch: (cause) => cause,
              }).pipe(
                Effect.catch((cause): Effect.Effect<never, PackTooLarge | PushRejected> =>
                  cause instanceof ReceivePackBusy
                    ? Effect.fail(new PushRejected({ reason: "busy" }))
                    : tooLarge(workspace)(cause),
                ),
              );
              if (outcome.kind !== "rejected") return outcome.kind satisfies SyncOutcome;
            }
            return yield* Effect.fail(new PushRejected({ reason: "stale" }));
          }),
      });
    }),
  );
