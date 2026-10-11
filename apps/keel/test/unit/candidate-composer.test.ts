// What the GitCore composer asks gitcore to restack: the committer, times and
// trailers come from the request alone, and each author from its submitted
// commit, so a recompose gives the same SHAs.
import { CommitSha, Instant, makeId } from "@keeltown/core/kernel";
import {
  CandidateComposer,
  type CandidateRequest,
  CodeHost,
  type RepoRef,
} from "@keeltown/core/ports";
import {
  concat,
  dec,
  decodeCommit,
  decodeTree,
  encodeCommit,
  FLUSH,
  hashObject,
  MissingObject,
  pkt,
  readPkts,
  type Signature,
} from "@keeltown/gitcore";
import { makeCodeHostMemory } from "@keeltown/testing";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CandidateComposerGitCore,
  restackSpec,
} from "../../src/adapters/driven/gitcore/candidate-composer.ts";

const sha = (c: string) => Schema.decodeUnknownSync(CommitSha)(c.repeat(40));
const AGENT = makeId("agt", "01J9ZZZZZZZZZZZZZZZZZZZZZA");
const CHANGE = makeId("chg", "01J9ZZZZZZZZZZZZZZZZZZZZZB");
const OTHER_AGENT = makeId("agt", "01J9ZZZZZZZZZZZZZZZZZZZZZC");
const OTHER_CHANGE = makeId("chg", "01J9ZZZZZZZZZZZZZZZZZZZZZD");
const CANDIDATE = makeId("cnd", "01J9ZZZZZZZZZZZZZZZZZZZZZE");
/** BatchFormed's time, 11 Oct 2026 09:00:00.250 UTC. */
const AT = Instant(1_791_709_200_250);
const AT_SECONDS = 1_791_709_200;

const REQUEST: CandidateRequest = {
  candidateId: CANDIDATE,
  staging: { namespace: "keel-core", name: "prj-staging" },
  base: sha("a"),
  at: AT,
  members: [
    {
      changeId: CHANGE,
      repo: { namespace: "keel-ws-00", name: "prj-ws-1" },
      base: sha("a"),
      head: sha("b"),
      author: AGENT,
      title: "Retry the webhook on 503",
    },
    {
      changeId: OTHER_CHANGE,
      repo: { namespace: "keel-ws-00", name: "prj-ws-2" },
      base: sha("c"),
      head: sha("d"),
      author: OTHER_AGENT,
      title: "Log the retry count",
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A receive-pack that takes every push and reports each command's ref ok. */
const acceptingGit: typeof globalThis.fetch = async (_input, init) => {
  const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
  const first = readPkts(body).next().value;
  const ref = first == null ? "" : (dec.decode(first).split("\0")[0]?.split(" ")[2] ?? "");
  return new Response(concat([pkt("unpack ok\n"), pkt(`ok ${ref}\n`), FLUSH]));
};

describe("the GitCore composer's restack", () => {
  it("[composer.deterministic] takes every identity and time from the request, never the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
    const once = restackSpec(REQUEST);
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
    expect(restackSpec(REQUEST)).toEqual(once);
    expect(once).toEqual({
      ref: `refs/heads/cand/${CANDIDATE}`,
      committer: { name: "Keel", email: "keel@keel.invalid", time: AT_SECONDS },
      members: [
        {
          base: sha("a"),
          head: sha("b"),
          message: "Retry the webhook on 503",
          trailers: [["Change-Id", CHANGE]],
        },
        {
          base: sha("c"),
          head: sha("d"),
          message: "Log the retry count",
          trailers: [["Change-Id", OTHER_CHANGE]],
        },
      ],
    });
  });

  it("[composer.keeps-author] the composed commit keeps the submitted commit's author, not the agent's, with Keel as committer", async () => {
    const code = makeCodeHostMemory();
    const staging: RepoRef = { namespace: "memory", name: "prj-staging" };
    const workspace: RepoRef = { namespace: "memory", name: "prj-ws-1" };
    const ada: Signature = { name: "Ada Lovelace", email: "ada@example.com", time: 1_712_345_678 };
    /** Every repo's objects, as gitcore reads them. */
    const open = async (repo: RepoRef) => {
      const objects = code.repos.get(`${repo.namespace}/${repo.name}`)?.objects;
      const read = (oid: string, type: string) => {
        const o = objects?.get(oid);
        if (o?.type !== type) throw new MissingObject(oid);
        return o.body;
      };
      return {
        readTree: async (oid: string) => decodeTree(read(oid, "tree")),
        readBlob: async (oid: string) => read(oid, "blob"),
        readCommit: async (oid: string) => decodeCommit(read(oid, "commit")),
        [Symbol.dispose]: () => undefined,
      };
    };
    const seeded = Effect.gen(function* () {
      const host = yield* CodeHost;
      yield* host.create(staging);
      const base = yield* code.fixture.commit(staging, "refs/heads/main", {
        "README.md": "base\n",
      });
      yield* host.fork(staging, workspace);
      const pushed = yield* code.fixture.commit(workspace, "refs/heads/main", {
        "README.md": "base\n",
        "src/retry.ts": "export const retries = 3;\n",
      });
      // The agent's own commit, authored by Ada: what the workspace's head holds.
      const objects = code.repos.get("memory/prj-ws-1")?.objects;
      const fixtureCommit = objects?.get(pushed);
      if (objects === undefined || fixtureCommit === undefined) throw new Error("no head");
      const { tree, parents } = decodeCommit(fixtureCommit.body);
      const body = encodeCommit({ tree, parents, author: ada, committer: ada, message: "wip\n" });
      const head = yield* Effect.promise(() => hashObject("commit", body));
      objects.set(head, { type: "commit", body });
      return { base, head: Schema.decodeUnknownSync(CommitSha)(head), tree };
    });
    const [member] = REQUEST.members;
    if (member === undefined) throw new Error("REQUEST has members");
    vi.stubGlobal("fetch", acceptingGit);
    const { base, head, tree, composed } = await Effect.runPromise(
      Effect.gen(function* () {
        const at = yield* seeded;
        const candidate = yield* (yield* CandidateComposer).compose({
          ...REQUEST,
          staging,
          base: at.base,
          members: [{ ...member, repo: workspace, base: at.base, head: at.head }],
        });
        return { ...at, composed: candidate };
      }).pipe(Effect.provide(CandidateComposerGitCore(open).pipe(Layer.provideMerge(code.layer)))),
    );
    expect(head).not.toBe(base);
    const expected = await hashObject(
      "commit",
      encodeCommit({
        tree,
        parents: [base],
        author: ada,
        committer: { name: "Keel", email: "keel@keel.invalid", time: AT_SECONDS },
        message: "Retry the webhook on 503",
        trailers: [["Change-Id", CHANGE]],
      }),
    );
    expect(composed.commitSha).toBe(expected);
    expect(composed.commits).toEqual([{ changeId: CHANGE, sha: expected }]);
  });
});
