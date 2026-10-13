import { CodeHost, type RepoRef } from "@keeltown/core/ports";
import { concat, FLUSH, pkt } from "@keeltown/gitcore";
import { Cause, Effect, Exit } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeHostArtifacts } from "../../src/adapters/driven/artifacts/code-host.ts";
import { FakeArtifacts, fakeRemote } from "./fake-artifacts.ts";

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

const withHost = <A, E>(binding: FakeArtifacts, body: Effect.Effect<A, E, CodeHost>) =>
  body.pipe(Effect.provide(CodeHostArtifacts({ [NAMESPACE]: binding })));

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
