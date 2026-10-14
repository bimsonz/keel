import { CommitSha } from "@keeltown/core/kernel";
import { CodeHost, type RepoRef } from "@keeltown/core/ports";
import { concat, FLUSH, pkt } from "@keeltown/gitcore";
import { Cause, Effect, Exit, Result, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodeHostArtifacts,
  type CodeHostOptions,
} from "../../src/adapters/driven/artifacts/code-host.ts";
import { FakeArtifacts, type FakeObjects, fakeRemote } from "./fake-artifacts.ts";

const NAMESPACE = "keel-core";
const UPSTREAM = "https://github.com/octocat/Hello-World";
const A = "a".repeat(40);
const B = "b".repeat(40);
const repo = (name: string): RepoRef => ({ namespace: NAMESPACE, name });

/** Serves each named repo's ref advertisement, as git's smart HTTP does, to whatever `fetch` asks for it. */
function advertise(refs: Readonly<Record<string, readonly (readonly [string, string])[]>>) {
  vi.stubGlobal("fetch", (input: string) => {
    const name = Object.keys(refs).find(
      (n) => input === `${fakeRemote(n)}/info/refs?service=git-upload-pack`,
    );
    if (name === undefined) return Promise.resolve(new Response("no such repo", { status: 404 }));
    const lines = (refs[name] ?? []).map(([ref, oid], i) =>
      pkt(`${oid} ${ref}${i === 0 ? "\0symref=HEAD:refs/heads/x agent=fake" : ""}\n`),
    );
    const body = concat([pkt("# service=git-upload-pack\n"), FLUSH, ...lines, FLUSH]);
    return Promise.resolve(new Response(body));
  });
}

/** A refusal as the binding throws one on the edge: an error with a code. */
const coded = (code: string, message = "ArtifactsError: something else") =>
  Object.assign(new Error(message), { code });

const tokenStates = (binding: FakeArtifacts) =>
  [...binding.repos].map(([name, tokens]) => [name, tokens.map((t) => t.state)]);

/** Runs `body` through one build of the host, so a cache the options ask for serves all of it. */
const withHost = <A, E>(
  binding: FakeArtifacts,
  body: Effect.Effect<A, E, CodeHost>,
  options?: CodeHostOptions,
) => body.pipe(Effect.provide(CodeHostArtifacts({ [NAMESPACE]: binding }, options)));

/** An id to serve an object under: `n` in 40 hex digits. */
const id = (n: number) => n.toString(16).padStart(40, "0");
const toSha = Schema.decodeUnknownSync(CommitSha);
const file = (name: string, hash: string): ArtifactsTreeEntry => ({
  name,
  mode: "100644",
  hash,
  type: "blob",
});
const dir = (name: string, hash: string): ArtifactsTreeEntry => ({
  name,
  mode: "40000",
  hash,
  type: "tree",
});

/** A binding serving one repo, `name`, with `objects`. */
const serving = (name: string, objects: FakeObjects) => {
  const binding = new FakeArtifacts();
  binding.serve(name, objects);
  return binding;
};

/** The tree ids the binding read for repo `name`, from its `from`th read on. */
const treesRead = (binding: FakeArtifacts, name: string, from = 0) =>
  binding.reads
    .slice(from)
    .filter((r) => r.kind === "tree" && r.repo === name)
    .map((r) => r.oid);

const pathsOf = (entries: readonly { readonly path: string }[]) => entries.map((e) => e.path);

describe("CodeHost on Artifacts: credentials", () => {
  it("[artifacts.no-standing-token] revokes the write token that create and fork hand back", async () => {
    const binding = new FakeArtifacts();
    const run = Effect.gen(function* () {
      const host = yield* CodeHost;
      const source = yield* host.create({ namespace: "keel-ws-00", name: "mirror" });
      yield* host.fork(source, { namespace: "keel-ws-00", name: "ws-1" });
    }).pipe(Effect.provide(CodeHostArtifacts({ "keel-ws-00": binding })));
    await Effect.runPromise(run);
    const states = [...binding.repos].map(([name, tokens]) => [name, tokens.map((t) => t.state)]);
    expect(states).toEqual([
      ["mirror", ["revoked"]],
      ["ws-1", ["revoked"]],
    ]);
  });
});

describe("CodeHost on Artifacts: import", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("[artifacts.import] answers the branch the new repo advertises, whatever the binding calls its default, and leaves no active token", async () => {
    const binding = new FakeArtifacts();
    advertise({
      trunk: [
        ["HEAD", A],
        ["refs/heads/master", A],
        ["refs/tags/v1", B],
      ],
      named: [
        ["HEAD", B],
        ["refs/heads/test", B],
      ],
    });
    const came = await Effect.runPromise(
      withHost(
        binding,
        Effect.gen(function* () {
          const host = yield* CodeHost;
          return [
            yield* host.import({ url: UPSTREAM }, repo("trunk")),
            yield* host.import({ url: UPSTREAM, ref: "test" }, repo("named")),
            yield* host.branches(repo("trunk")),
          ];
        }),
      ),
    );
    expect(came).toEqual([
      { ref: "refs/heads/master", commit: A },
      { ref: "refs/heads/test", commit: B },
      [{ ref: "refs/heads/master", commit: A }],
    ]);
    // The branch is named to the binding only when the caller named one.
    expect(binding.imports).toEqual([
      { source: { url: UPSTREAM }, target: { name: "trunk" } },
      { source: { url: UPSTREAM, branch: "test" }, target: { name: "named" } },
    ]);
    // The import's own write token, and each read token an advertisement was read with.
    expect(tokenStates(binding)).toEqual([
      ["trunk", ["revoked", "revoked", "revoked"]],
      ["named", ["revoked", "revoked"]],
    ]);
  });

  it("[artifacts.import-refused] reads each refusal of the binding as its reason, by its code or by its message alone", async () => {
    const refusals: readonly (readonly [Error, string])[] = [
      [coded("REMOTE_AUTH_REQUIRED"), "not-found"],
      [coded("NOT_FOUND"), "not-found"],
      [coded("INVALID_URL"), "not-git"],
      [coded("UPSTREAM_UNAVAILABLE"), "unreachable"],
      [coded("MEMORY_LIMIT"), "too-large"],
      [coded("NOT_FOUND", 'ArtifactsError: Branch not found: "no-such-branch".'), "no-branch"],
      // As wrangler's remote-binding proxy hands them on: the message, and no code (each read live).
      [
        new Error(
          `ArtifactsError: Repository "${UPSTREAM}" requires authentication (HTTP 401). Only public repositories can be imported.`,
        ),
        "not-found",
      ],
      [
        new Error(
          `ArtifactsError: Repository "${UPSTREAM}" was not found. Verify the URL is correct and the repository is public.`,
        ),
        "not-found",
      ],
      [new Error("ArtifactsError: The URL does not point to a git repository."), "not-git"],
      [
        new Error("ArtifactsError: The upstream service is unavailable. Please retry."),
        "unreachable",
      ],
      [new Error('ArtifactsError: Branch not found: "no-such-branch".'), "no-branch"],
    ];
    const binding = new FakeArtifacts();
    advertise({});
    for (const [refusal, reason] of refusals) {
      binding.refusal = refusal;
      const refused = await Effect.runPromise(
        withHost(
          binding,
          Effect.flatMap(CodeHost, (host) =>
            Effect.flip(host.import({ url: UPSTREAM }, repo("trunk"))),
          ),
        ),
      );
      expect([refusal.message, refused]).toMatchObject([
        refusal.message,
        { _tag: "ImportRefused", reason },
      ]);
    }
    expect([...binding.repos.keys()]).toEqual([]);
  });

  it("[artifacts.import-refused] a taken name is RepoAlreadyExists, and anything else the binding throws is a defect", async () => {
    const binding = new FakeArtifacts();
    advertise({ trunk: [["refs/heads/main", A]] });
    const exits = await Effect.runPromise(
      withHost(
        binding,
        Effect.gen(function* () {
          const host = yield* CodeHost;
          yield* host.import({ url: UPSTREAM }, repo("trunk"));
          const taken = yield* Effect.flip(host.import({ url: UPSTREAM }, repo("trunk")));
          binding.refusal = new Error("ArtifactsError: the import fell over");
          return [
            taken,
            yield* Effect.exit(host.import({ url: UPSTREAM }, repo("other"))),
          ] as const;
        }),
      ),
    );
    expect(exits[0]).toMatchObject({ _tag: "RepoAlreadyExists", repo: repo("trunk") });
    const died = exits[1];
    expect(Exit.isFailure(died) && Cause.hasDies(died.cause) && !Cause.hasFails(died.cause)).toBe(
      true,
    );
    expect(Exit.isFailure(died) ? Cause.pretty(died.cause) : "").toContain("the import fell over");
  });

  it("[artifacts.import-empty] an import that brought no branch is refused as no-branch, and its repo is deleted", async () => {
    const binding = new FakeArtifacts();
    advertise({ trunk: [] });
    const refused = await Effect.runPromise(
      withHost(
        binding,
        Effect.flatMap(CodeHost, (host) =>
          Effect.flip(host.import({ url: UPSTREAM }, repo("trunk"))),
        ),
      ),
    );
    expect(refused).toMatchObject({ _tag: "ImportRefused", reason: "no-branch" });
    expect([...binding.repos.keys()]).toEqual([]);
  });
});

describe("CodeHost on Artifacts: tree cache", () => {
  it("[code-host.tree-cache-by-repo] two repos holding the same tree id with different entries each answer their own through one cached build", async () => {
    const binding = new FakeArtifacts();
    const [commit, root, src] = [id(1), id(2), id(3)];
    binding.serve("one", {
      commits: { [commit]: root },
      trees: { [root]: [file("one.txt", id(10)), dir("src", src)], [src]: [file("a.ts", id(11))] },
    });
    binding.serve("two", {
      commits: { [commit]: root },
      trees: { [root]: [dir("src", src), file("two.txt", id(20))], [src]: [file("b.ts", id(21))] },
    });
    const read = (name: string) =>
      Effect.gen(function* () {
        const host = yield* CodeHost;
        return {
          root: pathsOf(yield* host.listDir(repo(name), toSha(commit), "")),
          tree: pathsOf(yield* host.readTree(repo(name), toSha(commit))),
        };
      });
    const [one, two, oneAgain] = await Effect.runPromise(
      withHost(binding, Effect.all([read("one"), read("two"), read("one")]), { trees: 8 }),
    );
    expect(one).toEqual({ root: ["one.txt", "src"], tree: ["one.txt", "src", "src/a.ts"] });
    expect(two).toEqual({ root: ["src", "two.txt"], tree: ["src", "src/b.ts", "two.txt"] });
    expect(oneAgain).toEqual(one);
    // Each repo's trees were read from its own handle once, and served from the cache after.
    expect(treesRead(binding, "one")).toEqual([root, src]);
    expect(treesRead(binding, "two")).toEqual([root, src]);
  });

  it("[code-host.tree-cache-reuses] a later walk through the same cached build reads only the trees no earlier walk did; with no cache it reads them all again", async () => {
    const [base, head] = [id(1), id(2)];
    // base: a/b and a/c under the root; head changes one file in a/b.
    const [root, a, b, c] = [id(10), id(11), id(12), id(13)];
    const [headRoot, headA, headB] = [id(20), id(21), id(22)];
    const objects: FakeObjects = {
      commits: { [base]: root, [head]: headRoot },
      trees: {
        [root]: [dir("a", a), file("top.txt", id(30))],
        [a]: [dir("b", b), dir("c", c)],
        [b]: [file("one.ts", id(31)), file("two.ts", id(32))],
        [c]: [file("c.ts", id(33))],
        [headRoot]: [dir("a", headA), file("top.txt", id(30))],
        [headA]: [dir("b", headB), dir("c", c)],
        [headB]: [file("one.ts", id(34)), file("two.ts", id(32))],
      },
    };
    /** Walks base, base again, then head, then diffs them, through one build: each step's answer and the trees it read. */
    const walks = (options: CodeHostOptions) => {
      const binding = serving("big", objects);
      const step = <A, E>(read: (host: (typeof CodeHost)["Service"]) => Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          const from = binding.reads.length;
          const answer = yield* read(yield* CodeHost);
          return { answer, trees: treesRead(binding, "big", from).toSorted() };
        });
      return Effect.runPromise(
        withHost(
          binding,
          Effect.all([
            step((host) => host.readTree(repo("big"), toSha(base))),
            step((host) => host.readTree(repo("big"), toSha(base))),
            step((host) => host.readTree(repo("big"), toSha(head))),
            step((host) => host.diffTrees(repo("big"), toSha(base), toSha(head))),
          ]),
          options,
        ),
      );
    };
    const cached = await walks({ trees: 8 });
    expect(cached.map((s) => s.trees)).toEqual([
      [root, a, b, c].toSorted(),
      [],
      [headRoot, headA, headB].toSorted(),
      [],
    ]);
    const uncached = await walks({});
    expect(uncached.map((s) => s.trees.length)).toEqual([4, 4, 4, 6]);
    // The cache changes what is read, never what is answered.
    expect(cached.map((s) => s.answer)).toEqual(uncached.map((s) => s.answer));
    const [first, second, third] = cached;
    expect(second?.answer).toEqual(first?.answer);
    expect(third?.answer).toContainEqual({
      path: "a/b/one.ts",
      mode: "100644",
      oid: id(34),
      type: "blob",
    });
  });

  it("[code-host.tree-cache-bound] past its bound the cache drops the tree least recently read, and keeps the ones read since", async () => {
    const commits = [id(1), id(2), id(3)];
    const roots = [id(11), id(12), id(13)];
    const binding = serving("small", {
      commits: Object.fromEntries(commits.map((c, n) => [c, roots[n] ?? ""])),
      trees: Object.fromEntries(roots.map((t, n) => [t, [file(`f${n}`, id(21 + n))]])),
    });
    // Each listing of a root reads its one tree; which of them reached the binding.
    const order = [0, 1, 2, 2, 1, 0, 1];
    const fromBinding = await Effect.runPromise(
      withHost(
        binding,
        Effect.forEach(order, (n) =>
          Effect.gen(function* () {
            const from = binding.reads.length;
            yield* (yield* CodeHost).listDir(repo("small"), toSha(commits[n] ?? ""), "");
            return treesRead(binding, "small", from).length > 0;
          }),
        ),
        { trees: 2 },
      ),
    );
    // The third tree drops the first; the second, read again, stays over the third when the first comes back.
    expect(fromBinding).toEqual([true, true, true, false, false, true, false]);
  });
});

describe("CodeHost on Artifacts: readBlobs", () => {
  it("[code-host.read-blobs-one-handle] reads every blob through one handle and answers in the order asked, a missing one as its ObjectNotFound; a missing repo is RepoNotFound", async () => {
    const oids = Array.from({ length: 20 }, (_, n) => id(100 + n));
    const binding = serving("blobs", {
      blobs: Object.fromEntries(oids.map((oid, n) => [oid, `blob ${n}`])),
    });
    const missing = id(999);
    // Backwards, with a missing one between, and the first asked answering last.
    const asked = [...oids.slice(10), missing, ...oids.slice(0, 10)].toReversed();
    for (const oid of asked.slice(0, 2)) binding.slow.add(oid);
    const text = new TextDecoder();
    const outcome = await Effect.runPromise(
      withHost(
        binding,
        Effect.gen(function* () {
          const host = yield* CodeHost;
          const before = binding.opened.length;
          const together = yield* host.readBlobs(repo("blobs"), asked);
          const opensTogether = binding.opened.length - before;
          yield* Effect.forEach(oids, (oid) => host.readBlob(repo("blobs"), oid));
          return {
            together,
            opensTogether,
            opensOneByOne: binding.opened.length - before - opensTogether,
            ghost: yield* Effect.flip(host.readBlobs(repo("ghost"), oids)),
          };
        }),
      ),
    );
    expect(outcome.opensTogether).toBe(1);
    expect(outcome.opensOneByOne).toBe(oids.length);
    expect(
      outcome.together.map((r) => (Result.isSuccess(r) ? text.decode(r.success) : r.failure)),
    ).toMatchObject(
      asked.map((oid) =>
        oid === missing
          ? { _tag: "ObjectNotFound", repo: repo("blobs"), oid }
          : `blob ${oids.indexOf(oid)}`,
      ),
    );
    expect(outcome.ghost).toMatchObject({ _tag: "RepoNotFound", repo: repo("ghost") });
  });
});
