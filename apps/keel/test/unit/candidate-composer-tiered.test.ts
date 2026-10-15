// The composer in tiers: GitCore composes what it can and the box is never
// asked; what GitCore refuses goes to MergeBox, whose tree keel commits onto
// trunk as GitCore would have, signed with the deployment's key, before the
// box's scratch ref is dropped; and what the box refuses too is the
// candidate's refusal, with nothing pushed.
import { CompositionRefused } from "@keeltown/core/domain/integration";
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
  importSshSigningKey,
  MissingObject,
  pkt,
  readPkts,
  type Signature,
  sshSignature,
} from "@keeltown/gitcore";
import { makeCodeHostMemory } from "@keeltown/testing";
import { makeCommitSigningKeys } from "@keeltown/testing/commit-signing-keys";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BoxComposer,
  CandidateComposerTiered,
} from "../../src/adapters/driven/gitcore/candidate-composer.ts";

const CHANGE = makeId("chg", "01J9ZZZZZZZZZZZZZZZZZZZZZB");
const CANDIDATE = makeId("cnd", "01J9ZZZZZZZZZZZZZZZZZZZZZE");
const AT = Instant(1_791_709_200_250);
const KEEL: Signature = { name: "Keel", email: "keel@keel.test", time: 1_791_709_200 };
const ADA: Signature = { name: "Ada Lovelace", email: "ada@example.com", time: 1_712_345_678 };
const TITLE = "Retry the webhook on 503";
const CHECK = { canary: "found", tokens: "none" } as const;

afterEach(() => vi.unstubAllGlobals());

/** A receive-pack that takes every push, recording each command line it was sent. */
function acceptingGit() {
  const commands: string[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
    const first = readPkts(body).next().value;
    const command = first == null ? "" : (dec.decode(first).split("\0")[0] ?? "");
    commands.push(command);
    return new Response(concat([pkt("unpack ok\n"), pkt(`ok ${command.split(" ")[2]}\n`), FLUSH]));
  };
  return { fetch, commands };
}

/** A box that answers `answer` and counts what it was asked. */
function fakeBox(answer: (request: CandidateRequest) => ReturnType<BoxComposer["compose"]>) {
  const asked: CandidateRequest[] = [];
  const box: BoxComposer = {
    compose: (request) => {
      asked.push(request);
      return answer(request);
    },
  };
  return { box, asked };
}

/**
 * One change, Ada's, made on trunk's first commit, composed onto trunk's
 * second: `edit` is what the change does to the README trunk's second commit
 * also rewrote, so GitCore refuses it unless the change leaves that line be.
 */
async function composedInTiers(
  edit: string,
  boxFor: (tree: string) => BoxComposer,
  gitcoreOnly = false,
) {
  const keys = await makeCommitSigningKeys();
  const code = makeCodeHostMemory();
  const staging: RepoRef = { namespace: "memory", name: "prj-staging" };
  const workspace: RepoRef = { namespace: "memory", name: "prj-ws-1" };
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
  const git = acceptingGit();
  vi.stubGlobal("fetch", git.fetch);
  const seeded = await Effect.runPromise(
    Effect.gen(function* () {
      const host = yield* CodeHost;
      yield* host.create(staging);
      const first = yield* code.fixture.commit(staging, "refs/heads/main", {
        "README.md": "base\n",
        "src/a.ts": "a\n",
      });
      yield* host.fork(staging, workspace);
      const trunk = yield* code.fixture.commit(staging, "refs/heads/main", {
        "README.md": "trunk\n",
        "src/a.ts": "a\n",
      });
      const pushed = yield* code.fixture.commit(
        workspace,
        "refs/heads/main",
        edit === ""
          ? { "README.md": "base\n", "src/a.ts": "a\n", "src/b.ts": "b\n" }
          : { "README.md": edit, "src/a.ts": "a\n" },
      );
      const objects = code.repos.get("memory/prj-ws-1")?.objects;
      const fixture = objects?.get(pushed);
      if (objects === undefined || fixture === undefined) throw new Error("no head");
      const { tree, parents } = decodeCommit(fixture.body);
      const body = encodeCommit({ tree, parents, author: ADA, committer: ADA, message: "wip\n" });
      const head = yield* Effect.promise(() => hashObject("commit", body));
      objects.set(head, { type: "commit", body });
      return { first, trunk, head: Schema.decodeUnknownSync(CommitSha)(head), tree };
    }).pipe(Effect.provide(code.layer)),
  );
  const { first, trunk, tree } = seeded;
  const layer = CandidateComposerTiered(open, { host: "keel.test", ...keys }, boxFor(tree)).pipe(
    Layer.provide(code.layer),
  );
  const exit = await Effect.runPromise(
    Effect.exit(
      CandidateComposer.use((composer) =>
        composer.compose({
          candidateId: CANDIDATE,
          staging,
          base: trunk,
          at: AT,
          members: [
            { changeId: CHANGE, repo: workspace, base: first, head: seeded.head, title: TITLE },
          ],
          ...(gitcoreOnly ? { gitcoreOnly: true as const } : {}),
        }),
      ),
    ).pipe(Effect.provide(layer)),
  );
  /** The commit keel writes over `onto` with the deployment's key: what a composed tree should land as. */
  const signedOver = async (onto: string) => {
    const unsigned = encodeCommit({
      tree: onto,
      parents: [trunk],
      author: ADA,
      committer: KEEL,
      message: TITLE,
      trailers: [["Change-Id", CHANGE]],
    });
    const gpgsig = await sshSignature(await importSshSigningKey(keys.signingKey), unsigned);
    return hashObject(
      "commit",
      encodeCommit({
        tree: onto,
        parents: [trunk],
        author: ADA,
        committer: KEEL,
        message: TITLE,
        trailers: [["Change-Id", CHANGE]],
        gpgsig,
      }),
    );
  };
  return { exit, pushes: git.commands, boxTree: tree, signedOver };
}

describe("the composer in tiers", () => {
  it("[compose.tiered-first] a batch GitCore composes is GitCore's, and the box is never asked", async () => {
    const fake = fakeBox(() => Effect.die(new Error("the box was asked")));
    const run = await composedInTiers("", () => fake.box);
    if (!Exit.isSuccess(run.exit)) throw new Error(String(run.exit.cause));
    expect(run.exit.value).toMatchObject({ composer: "gitcore", tier: 0 });
    expect(run.exit.value.boxCheck).toBeUndefined();
    expect(fake.asked).toHaveLength(0);
    expect(run.pushes).toHaveLength(1);
  });

  it("[compose.tiered-box] a batch GitCore refuses is composed over the box's tree, signed in keel onto trunk, with GitCore's reason and the box's check, and the box's scratch ref dropped", async () => {
    const scratch = `refs/keel/box/${CANDIDATE}`;
    let fake = fakeBox(() => Effect.die(new Error("no box made")));
    const run = await composedInTiers("mine\n", (tree) => {
      fake = fakeBox(() =>
        Effect.succeed({ trees: [tree], scratch, tip: "f".repeat(40), boxCheck: CHECK }),
      );
      return fake.box;
    });
    if (!Exit.isSuccess(run.exit)) throw new Error(String(run.exit.cause));
    const composed = run.exit.value;
    expect(fake.asked).toHaveLength(1);
    expect(composed.composer).toBe("mergebox");
    expect(composed.tier).toBe(2);
    expect(composed.tierReason).toMatch(/^MergeBox: .*where GitCore refused \(.+ README\.md\)$/);
    expect(composed.boxCheck).toEqual(CHECK);
    expect(composed.treeSha).toBe(run.boxTree);
    expect(composed.commitSha).toBe(await run.signedOver(run.boxTree));
    expect(composed.commits).toEqual([{ changeId: CHANGE, sha: composed.commitSha }]);
    expect(run.pushes).toEqual([
      `${"0".repeat(40)} ${composed.commitSha} refs/heads/cand/${CANDIDATE}`,
      `${"f".repeat(40)} ${"0".repeat(40)} ${scratch}`,
    ]);
  });

  it("[compose.gitcore-only] a batch composed in GitCore alone that GitCore refuses is refused with GitCore's reason, and the box is never asked", async () => {
    const fake = fakeBox(() => Effect.die(new Error("the box was asked")));
    const run = await composedInTiers("mine\n", () => fake.box, true);
    expect(fake.asked).toHaveLength(0);
    if (Exit.isSuccess(run.exit)) throw new Error("composed");
    expect(Cause.squash(run.exit.cause)).toBeInstanceOf(CompositionRefused);
    expect(run.pushes).toHaveLength(0);
  });

  it("[compose.tiered-both-refuse] a batch the box refuses too is refused with the box's reason and paths, and nothing is pushed", async () => {
    const fake = fakeBox(() =>
      Effect.fail(new CompositionRefused({ reason: "conflict", paths: ["README.md"] })),
    );
    const run = await composedInTiers("mine\n", () => fake.box);
    expect(fake.asked).toHaveLength(1);
    if (Exit.isSuccess(run.exit)) throw new Error("composed");
    expect(Cause.squash(run.exit.cause)).toEqual(
      new CompositionRefused({ reason: "conflict", paths: ["README.md"] }),
    );
    expect(run.pushes).toHaveLength(0);
  });
});
