import { gitRemote } from "./remote.ts";
import { CommitSha } from "@keeltown/core/kernel";
import {
  CodeHost,
  EditsRefused,
  ObjectNotFound,
  PackTooLarge,
  RELAY_PACK_CAP_BYTES,
  type RepoRef,
  WORKSPACE_BRANCH,
  type WorkspaceCommit,
  WorkspaceHeadMoved,
  WorkspaceWriter,
} from "@keeltown/core/ports";
import {
  applyEdits,
  EditRefused,
  encodeCommit,
  type GitObject,
  hashObject,
  MissingObject,
  receivePack,
  writePack,
} from "@keeltown/gitcore";
import { Effect, Layer, Schema } from "effect";
import type { OpenObjects } from "./candidate-composer.ts";
import { agentAuthor, keelCommitter } from "./commit-signing.ts";

/** A workspace write token lives a minute, minted for the one push that needs it. */
const TOKEN_TTL_SECONDS = 60;

/** How many times the push is sent again while the workspace answers busy. */
const BUSY_RETRIES = 3;

const toCommitSha = Schema.decodeUnknownSync(CommitSha);

interface Composed {
  readonly commit: string;
  readonly tree: string;
  readonly changed: number;
  readonly objects: readonly GitObject[];
}

/**
 * WorkspaceWriter over GitCore and the code host. The parent's tree is read
 * through one handle on the workspace and only the trees on edited paths are
 * rebuilt; the commit names the agent as author and Keel as committer,
 * unsigned (landing re-makes and signs the commit trunk gets). The push
 * carries `expectedHead` as its old value, so a branch that moved refuses it.
 * The token and the remote, which carries the account id, never reach an
 * error or a log.
 */
export const WorkspaceWriterGitCore = (open: OpenObjects, host: string) => {
  const read = <A>(
    workspace: RepoRef,
    use: (reader: Awaited<ReturnType<OpenObjects>>) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: async () => {
        using reader = await open(workspace);
        return await use(reader);
      },
      catch: (cause) => cause,
    });

  const compose = (workspace: RepoRef, request: WorkspaceCommit) =>
    read(workspace, async (reader): Promise<Composed> => {
      const parent = await reader.readCommit(request.parent);
      const edited = await applyEdits(reader, parent.tree, request.edits);
      const author = agentAuthor(
        { id: request.author.agentId, handle: request.author.handle },
        host,
      );
      const body = encodeCommit({
        tree: edited.tree,
        parents: [request.parent],
        author: { ...author, time: Math.floor(request.at / 1000) },
        committer: keelCommitter(host, request.at),
        message: request.message,
      });
      return {
        commit: await hashObject("commit", body),
        tree: edited.tree,
        changed: edited.changed,
        objects: [...edited.newObjects.values(), { type: "commit", body }],
      };
    }).pipe(
      Effect.catch((cause): Effect.Effect<never, EditsRefused | ObjectNotFound> =>
        cause instanceof EditRefused
          ? Effect.fail(new EditsRefused({ reason: cause.reason, path: cause.path }))
          : cause instanceof MissingObject
            ? Effect.fail(new ObjectNotFound({ repo: workspace, oid: cause.oid }))
            : Effect.die(cause),
      ),
    );

  /** Whether the branch's head is this commit already: same parent, same tree (a retry whose first push landed). */
  const replayed = (workspace: RepoRef, head: string, request: WorkspaceCommit, tree: string) =>
    read(workspace, async (reader) => {
      const at = await reader.readCommit(head);
      return at.tree === tree && at.parents.length === 1 && at.parents[0] === request.parent;
    }).pipe(Effect.orElseSucceed(() => false));

  return Layer.effect(
    WorkspaceWriter,
    Effect.gen(function* () {
      const code = yield* CodeHost;

      const headOf = (workspace: RepoRef) =>
        code.head(workspace, WORKSPACE_BRANCH).pipe(
          Effect.map((sha): string | null => sha),
          Effect.catchTag("RefNotFound", () => Effect.succeed(null)),
        );

      return WorkspaceWriter.of({
        commit: (workspace, request) =>
          Effect.gen(function* () {
            const composed = yield* compose(workspace, request);
            if (composed.changed === 0)
              return yield* Effect.fail(new EditsRefused({ reason: "nothing-changed", path: "" }));
            const pack = yield* Effect.promise(() => writePack(composed.objects));
            if (pack.length > RELAY_PACK_CAP_BYTES)
              return yield* Effect.fail(
                new PackTooLarge({
                  repo: { namespace: workspace.namespace, name: workspace.name },
                  bytes: pack.length,
                  limit: RELAY_PACK_CAP_BYTES,
                }),
              );
            const info = yield* code.info(workspace);
            const token = yield* code.mintToken(workspace, "write", TOKEN_TTL_SECONDS);
            const remote = gitRemote(info.remote, token.token);
            const answer = {
              commitSha: toCommitSha(composed.commit),
              tree: composed.tree,
              changed: composed.changed,
            };
            for (let attempt = 0; attempt <= BUSY_RETRIES; attempt += 1) {
              const outcome = yield* Effect.promise(() =>
                receivePack(
                  remote,
                  [{ ref: WORKSPACE_BRANCH, old: request.expectedHead, new: composed.commit }],
                  pack,
                ),
              );
              if (outcome.kind === "applied") return answer;
              if (outcome.kind === "busy") {
                yield* Effect.sleep(50 * 2 ** attempt);
                continue;
              }
              if (outcome.kind === "rejected") {
                const head = yield* headOf(workspace);
                if (head !== null && (yield* replayed(workspace, head, request, composed.tree)))
                  return { ...answer, commitSha: toCommitSha(head) };
                return yield* Effect.fail(
                  new WorkspaceHeadMoved({ expected: request.expectedHead, head }),
                );
              }
              return yield* Effect.die(new Error(`the workspace push was ${outcome.kind}`));
            }
            return yield* Effect.die(new Error("the workspace stayed busy for the push"));
          }),
      });
    }),
  );
};
