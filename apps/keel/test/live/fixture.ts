import { CommitSha } from "@keeltown/core/kernel";
import { RepoNotFound, type RepoRef } from "@keeltown/core/ports";
import { receivePack, writePack, ZERO_OID } from "@keeltown/gitcore";
import { buildCommit, buildTree, CodeHostFixture, type Upstreams } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";

const toCommitSha = Schema.decodeUnknownSync(CommitSha);

/**
 * Real upstreams for the import cases. The repository is GitHub's own demo:
 * small, public, unchanged for years, and its default branch is `master`.
 * The missing one is a name under Keel's own account that holds nothing (a
 * private repository answers the same); the page that is not git is Keel's
 * sign-in page.
 */
const UPSTREAMS: Upstreams = {
  url: "https://github.com/octocat/Hello-World",
  byDefault: {
    name: "master",
    ref: "refs/heads/master",
    commit: toCommitSha("7fd1a60b01f91b314f59955a4e4d4e80d8edf11d"),
  },
  other: {
    name: "test",
    ref: "refs/heads/test",
    commit: toCommitSha("b3cbd5bbd7e81436d2eee04537ea2b4c0cad4cdf"),
  },
  missing: "https://github.com/bimsonz/keel-no-such-repository",
  notGit: "https://keel.town/sign-in",
};

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
    commit: (repo, ref, files, merged = []) =>
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
            const commit = await buildCommit(tree, [
              ...(parent === undefined ? [] : [parent]),
              ...merged,
            ]);
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
    upstreams: Effect.succeed(UPSTREAMS),
  });
  return { made, fixture, layer: Layer.succeed(CodeHostFixture, fixture) };
}
