import { CommitSha } from "@keeltown/core/kernel";
import { RepoNotFound, type RepoRef } from "@keeltown/core/ports";
import { receivePack, writePack, ZERO_OID } from "@keeltown/gitcore";
import { buildCommit, buildTree, CodeHostFixture } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";

const toCommitSha = Schema.decodeUnknownSync(CommitSha);

/**
 * CodeHostFixture for a real Artifacts namespace: a commit is built with
 * gitcore and pushed over receive-pack with a 10-minute write token, its old
 * id the ref's current head. Every scratch repo is remembered, so a test file
 * can delete what it made.
 */
export function artifactsFixture(namespace: string, binding: Artifacts) {
  const made: RepoRef[] = [];
  const fixture = CodeHostFixture.of({
    scratch: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      const repo = {
        namespace,
        name: `ct-${Date.now().toString(36)}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      };
      made.push(repo);
      return repo;
    },
    commit: (repo, ref, files) =>
      Effect.tryPromise({
        try: async () => {
          const handle = await binding.get(repo.name);
          try {
            // The binding's log resolves branch names, not full ref names.
            const [current] = await handle.log({
              ref: ref.replace(/^refs\/heads\//, ""),
              limit: 1,
            });
            const parent = current?.hash;
            const { tree, objects } = await buildTree(files);
            const commit = await buildCommit(tree, parent === undefined ? [] : [parent]);
            const [info, token] = await Promise.all([
              handle.info(),
              handle.createToken("write", 600),
            ]);
            const pack = await writePack([...objects.values(), commit.object]);
            const outcome = await receivePack(
              { url: info.remote, token: token.plaintext },
              [{ ref, old: parent ?? ZERO_OID, new: commit.oid }],
              pack,
            );
            if (outcome.kind !== "applied")
              throw new Error(`fixture push was not applied: ${JSON.stringify(outcome)}`);
            return toCommitSha(commit.oid);
          } finally {
            handle[Symbol.dispose]();
          }
        },
        catch: (e) => e,
      }).pipe(
        Effect.catch((e) =>
          typeof e === "object" && e !== null && "code" in e && e.code === "NOT_FOUND"
            ? Effect.fail(
                new RepoNotFound({ repo: { namespace: repo.namespace, name: repo.name } }),
              )
            : Effect.die(e),
        ),
      ),
  });
  return { made, fixture, layer: Layer.succeed(CodeHostFixture, fixture) };
}
