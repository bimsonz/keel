// The push client against real git: requests go to `git receive-pack
// --stateless-rpc` on a local bare repo, which checks each update's old id
// the way a smart-HTTP server does.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { concat, enc, ZERO_OID } from "../src/bytes.ts";
import { encodeCommit, encodeTree, type GitObject, hashObject } from "../src/objects.ts";
import { writePack } from "../src/pack-write.ts";
import { BUSY, FLUSH, type GitRemote, pkt, receivePack } from "../src/push.ts";
import { PROPERTY_TIMEOUT } from "./support/fast-check.ts";
import { gitSync, tempRepo } from "./git-harness.ts";

const repo = tempRepo();
afterAll(() => repo.cleanup());

/** A fetch that answers receive-pack requests from the bare repo, as a smart-HTTP server would. */
const localGit: typeof fetch = async (_url, init) => {
  const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
  const run = gitSync(["receive-pack", "--stateless-rpc", repo.dir], { input: body });
  if (run.status !== 0) return new Response(run.stderr, { status: 500 });
  return new Response(new Uint8Array(run.stdout), { status: 200 });
};
const remote: GitRemote = { url: "https://git.invalid/repo.git", token: "unused", fetch: localGit };

/** A commit holding one file, plus every object it needs. */
async function commit(
  content: string,
  parents: readonly string[] = [],
): Promise<{ readonly oid: string; readonly objects: GitObject[] }> {
  const blob = enc.encode(content);
  const tree = encodeTree([{ name: "f", mode: "100644", oid: await hashObject("blob", blob) }]);
  const who = { name: "t", email: "t@example.com", time: 1_700_000_000 };
  const body = encodeCommit({
    tree: await hashObject("tree", tree),
    parents,
    author: who,
    committer: who,
    message: content,
  });
  return {
    oid: await hashObject("commit", body),
    objects: [
      { type: "blob", body: blob },
      { type: "tree", body: tree },
      { type: "commit", body },
    ],
  };
}

const refOf = (ref: string) => {
  const run = gitSync(["rev-parse", "--verify", "-q", ref], { cwd: repo.dir });
  return run.status === 0 ? run.stdout.toString().trim() : null;
};

describe("receive-pack push", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[push.pack-valid] writes packs that git index-pack --strict accepts", async () => {
    const { objects } = await commit("packed\n");
    const path = join(repo.dir, "check.pack");
    writeFileSync(path, await writePack(objects));
    const run = gitSync(["index-pack", "--strict", path], { cwd: repo.dir });
    expect(run.stderr.toString()).toBe("");
    expect(run.stdout.toString().trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("[push.report] moves a ref only when its old id matches, and says so", async () => {
    const first = await commit("one\n");
    const second = await commit("two\n", [first.oid]);
    const other = await commit("other\n");
    const main = "refs/heads/main";

    expect(
      await receivePack(
        remote,
        [{ ref: main, old: ZERO_OID, new: first.oid }],
        await writePack(first.objects),
      ),
    ).toEqual({ kind: "applied" });
    expect(refOf(main)).toBe(first.oid);

    // A stale old id, and "must not exist" on a ref that exists: refused, ref untouched.
    const stale = await receivePack(
      remote,
      [{ ref: main, old: other.oid, new: second.oid }],
      await writePack(second.objects),
    );
    expect(stale).toMatchObject({ kind: "rejected", unpack: "ok" });
    const exists = await receivePack(
      remote,
      [{ ref: main, old: ZERO_OID, new: second.oid }],
      await writePack(second.objects),
    );
    expect(exists.kind).toBe("rejected");
    expect(refOf(main)).toBe(first.oid);

    // The matching old id moves it.
    expect(
      await receivePack(
        remote,
        [{ ref: main, old: first.oid, new: second.oid }],
        await writePack(second.objects),
      ),
    ).toEqual({ kind: "applied" });
    expect(refOf(main)).toBe(second.oid);

    // Two refs, one stale: atomic, so neither moves.
    const side = "refs/keel/side";
    const both = await receivePack(
      remote,
      [
        { ref: side, old: ZERO_OID, new: other.oid },
        { ref: main, old: first.oid, new: other.oid },
      ],
      await writePack(other.objects),
    );
    expect(both.kind).toBe("rejected");
    expect([refOf(side), refOf(main)]).toEqual([null, second.oid]);
  });

  it("[push.busy] reads Artifacts' busy refusal as busy, never as applied", async () => {
    const answers = [concat([pkt(`ERR ${BUSY}\n`)]), concat([pkt(`ERR ${BUSY}\n`), FLUSH])];
    for (const answer of answers) {
      const busy = await receivePack(
        { ...remote, fetch: () => Promise.resolve(new Response(answer, { status: 200 })) },
        [{ ref: "refs/heads/main", old: ZERO_OID, new: "1".repeat(40) }],
        new Uint8Array(0),
      );
      expect(busy).toEqual({ kind: "busy" });
    }
    const silent = await receivePack(
      { ...remote, fetch: () => Promise.resolve(new Response(FLUSH, { status: 200 })) },
      [{ ref: "refs/heads/main", old: ZERO_OID, new: "1".repeat(40) }],
      new Uint8Array(0),
    );
    expect(silent.kind).toBe("rejected");
    const missing = await receivePack(
      { ...remote, fetch: () => Promise.resolve(new Response("internal", { status: 500 })) },
      [{ ref: "refs/heads/main", old: ZERO_OID, new: "1".repeat(40) }],
      new Uint8Array(0),
    );
    expect(missing).toMatchObject({ kind: "failed", status: 500 });
    expect(JSON.stringify(missing)).not.toContain("git.invalid");
  });
});
