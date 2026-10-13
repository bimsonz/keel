// The relay against real git: fetches go to `git upload-pack --stateless-rpc`
// on a source bare repo, and pushes to `git receive-pack --stateless-rpc` on a
// target, as Keel's sync copies trunk into staging and the mirror.

import { afterAll, describe, expect, it } from "vitest";
import { concat, dec, enc } from "../src/bytes.ts";
import {
  PackTooLarge,
  relay,
  type RelayMove,
  RelayNotForward,
  relayPack,
  uploadPack,
  uploadPackBytes,
} from "../src/fetch.ts";
import { FLUSH, type GitRemote, pkt } from "../src/push.ts";
import { git, gitSync, smartHttp, tempRepo } from "./git-harness.ts";
import { PROPERTY_TIMEOUT } from "./support/fast-check.ts";

const repos = { source: tempRepo(), target: tempRepo() };
afterAll(() => {
  repos.source.cleanup();
  repos.target.cleanup();
});

const http = smartHttp({ source: repos.source.dir, target: repos.target.dir });
const remoteOf = (name: string): GitRemote => ({
  url: `https://git.invalid/${name}`,
  token: "unused",
  fetch: http.fetch,
});
const source = remoteOf("source");
const target = remoteOf("target");
const MAIN = "refs/heads/main";

/** Commits one file on top of `parent` in `dir` and moves main there. */
function commitFile(dir: string, path: string, content: string, parent?: string): string {
  const blob = git(dir, ["hash-object", "-w", "--stdin"], content).trim();
  const tree = git(dir, ["mktree"], `100644 blob ${blob}\t${path}\n`).trim();
  const sha = git(dir, [
    "commit-tree",
    ...(parent === undefined ? [] : ["-p", parent]),
    "-m",
    `${path}: ${content.length} bytes`,
    tree,
  ]).trim();
  git(dir, ["update-ref", MAIN, sha]);
  return sha;
}

const headOf = (dir: string): string | null => {
  const run = gitSync(["rev-parse", "--verify", "-q", MAIN], { cwd: dir });
  return run.status === 0 ? run.stdout.toString().trim() : null;
};

/** The target holds every object the commit reaches, not just the ref. */
const connected = (dir: string, sha: string) =>
  gitSync(["rev-list", "--objects", "--missing=print", sha], { cwd: dir })
    .stdout.toString()
    .split("\n")
    .filter((line) => line.startsWith("?"));

/** `remote`, its every answer handed over `size` bytes at a time, so a read ends wherever `size` puts it. */
const inChunksOf = (remote: GitRemote, size: number): GitRemote => ({
  ...remote,
  fetch: async (url, init) => {
    const whole = new Uint8Array(
      await (await (remote.fetch ?? http.fetch)(url, init)).arrayBuffer(),
    );
    let at = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= whole.length) controller.close();
          else controller.enqueue(whole.slice(at, (at += size)));
        },
      }),
    );
  },
});

/** A remote whose upload-pack answers exactly `answer`. */
const answering = (answer: Uint8Array): GitRemote => ({
  ...source,
  fetch: async () => new Response(Uint8Array.from(answer)),
});

/** Text that deflate cannot shrink much: enough of it makes a pack of several side-band packets. */
function noise(lines: number): string {
  let state = 20_261_012;
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x9e3779b9;
    out.push((state >>> 0).toString(36) + Math.imul(state, 0x85ebca6b).toString(36));
  }
  return `${out.join("\n")}\n`;
}

/** The object count in a pack's header. */
const count = (pack: Uint8Array) => new DataView(pack.buffer, pack.byteOffset).getUint32(8);

describe("relay", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[sync.empty-then-advance] copies trunk into an empty repo, then each new head after it", async () => {
    const first = commitFile(repos.source.dir, "a.txt", "one\n");
    expect(headOf(repos.target.dir)).toBeNull();
    expect(await relay(source, target, { ref: MAIN, from: null, to: first })).toEqual({
      kind: "advanced",
    });
    expect(headOf(repos.target.dir)).toBe(first);
    expect(connected(repos.target.dir, first)).toEqual([]);

    const second = commitFile(repos.source.dir, "a.txt", "two\n", first);
    expect(await relay(source, target, { ref: MAIN, from: first, to: second })).toEqual({
      kind: "advanced",
    });
    expect(headOf(repos.target.dir)).toBe(second);
    expect(connected(repos.target.dir, second)).toEqual([]);
  });

  it("[sync.idempotent] a target already at the source's head is left alone, with nothing sent", async () => {
    const head = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "idem\n");
    if (headOf(repos.target.dir) !== head)
      await relay(source, target, { ref: MAIN, from: headOf(repos.target.dir), to: head });
    const before = http.served.requests;
    expect(await relay(source, target, { ref: MAIN, from: head, to: head })).toEqual({
      kind: "unchanged",
    });
    expect(http.served.requests).toBe(before);
    expect(headOf(repos.target.dir)).toBe(head);
  });

  it("[sync.stale] a target that moved since it was read refuses the relay and keeps its head", async () => {
    const base = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "base\n");
    if (headOf(repos.target.dir) !== base)
      await relay(source, target, { ref: MAIN, from: headOf(repos.target.dir), to: base });
    const elsewhere = commitFile(repos.target.dir, "b.txt", "moved meanwhile\n", base);
    const next = commitFile(repos.source.dir, "a.txt", "next\n", base);
    const outcome = await relay(source, target, { ref: MAIN, from: base, to: next });
    expect(outcome.kind).toBe("rejected");
    expect(headOf(repos.target.dir)).toBe(elsewhere);
  });

  it("[sync.too-large] a pack over the cap fails loudly and pushes nothing", async () => {
    const before = headOf(repos.target.dir);
    const big = commitFile(
      repos.source.dir,
      "big.txt",
      "x".repeat(4096),
      headOf(repos.source.dir) ?? undefined,
    );
    await expect(
      relay(source, target, { ref: MAIN, from: before, to: big }, { maxPackBytes: 64 }),
    ).rejects.toBeInstanceOf(PackTooLarge);
    expect(headOf(repos.target.dir)).toBe(before);
  });

  it("[relay.haves] a new ref in a repo that holds the history carries only the commits past its haves", async () => {
    const base = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "x\n");
    await relay(source, target, { ref: MAIN, from: headOf(repos.target.dir), to: base });
    const tip = commitFile(repos.source.dir, "d.txt", "trunk moved on\n", base);
    const sent: number[] = [];
    const watched: GitRemote = {
      ...target,
      fetch: async (url, init) => {
        const body = init?.body;
        if (body instanceof Uint8Array) {
          const at = dec.decode(body).indexOf("PACK");
          if (at >= 0) sent.push(count(body.subarray(at)));
        }
        return http.fetch(url, init);
      },
    };
    const ref = "refs/heads/keel/trunk";
    const moved = await relay(source, watched, { ref, from: null, to: tip, haves: [base] });
    expect(moved).toEqual({ kind: "advanced" });
    // tip's commit, tree and blob, not the history the target already holds.
    expect(sent).toEqual([3]);
    expect(git(repos.target.dir, ["rev-parse", ref]).trim()).toBe(tip);
    expect(connected(repos.target.dir, tip)).toEqual([]);
  });

  it("[relay.forward-only] a head behind the commit the target's ref holds is not relayed: nothing is pushed, and the ref stays where it was", async () => {
    const older = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "x\n");
    const newer = commitFile(repos.source.dir, "f.txt", "trunk moved on again\n", older);
    const ref = "refs/heads/forward-only";
    const pushes: number[] = [];
    const watched: GitRemote = {
      ...target,
      fetch: async (url, init) => {
        const body = init?.body;
        // Only a push carries a pack in its request.
        if (body instanceof Uint8Array && dec.decode(body).includes("PACK")) pushes.push(1);
        return http.fetch(url, init);
      },
    };
    expect(await relay(source, watched, { ref, from: null, to: newer })).toEqual({
      kind: "advanced",
    });
    expect(pushes).toHaveLength(1);

    // The source has nothing of `older` to send past `newer`: the move would take the ref back.
    await expect(relay(source, watched, { ref, from: newer, to: older })).rejects.toBeInstanceOf(
      RelayNotForward,
    );
    expect(pushes).toHaveLength(1);
    expect(git(repos.target.dir, ["rev-parse", ref]).trim()).toBe(newer);
  });

  it("[relay.haves-vouch] a move that names its own haves is relayed even when nothing is left to send: a ref behind what the repo already holds is brought forward", async () => {
    const older = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "x\n");
    const newer = commitFile(repos.source.dir, "g.txt", "held under another ref\n", older);
    const held = "refs/heads/vouch-held";
    const ref = "refs/heads/vouch-trunk";
    // The repo holds `newer` under one ref, and `older` under the ref to move.
    await relay(source, target, { ref: held, from: null, to: newer });
    await relay(source, target, { ref, from: null, to: older, haves: [newer] });
    expect(git(repos.target.dir, ["rev-parse", ref]).trim()).toBe(older);

    expect(
      await relay(source, target, { ref, from: older, to: newer, haves: [newer, older] }),
    ).toEqual({ kind: "advanced" });
    expect(git(repos.target.dir, ["rev-parse", ref]).trim()).toBe(newer);
  });

  it("[relay.pack] relayPack answers the very pack a relay of the same move sends, byte for byte", async () => {
    const base = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "x\n");
    await relay(source, target, { ref: MAIN, from: headOf(repos.target.dir), to: base });
    const tip = commitFile(repos.source.dir, "e.txt", "weighed before it is sent\n", base);
    const move: RelayMove = { ref: "refs/heads/weighed", from: null, to: tip, haves: [base] };
    const weighed = await relayPack(source, move);
    // tip's commit, tree and blob, as the haves leave it.
    expect(count(weighed)).toBe(3);
    const sent: Uint8Array[] = [];
    const watched: GitRemote = {
      ...target,
      fetch: async (url, init) => {
        const body = init?.body;
        if (body instanceof Uint8Array) {
          const at = dec.decode(body).indexOf("PACK");
          if (at >= 0) sent.push(Uint8Array.from(body.subarray(at)));
        }
        return http.fetch(url, init);
      },
    };
    expect(await relay(source, watched, move)).toEqual({ kind: "advanced" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.length).toBe(weighed.length);
    expect(sent[0]).toEqual(weighed);
  });

  it("[relay.pack-cap] a pack of exactly the cap is answered, and one byte over is PackTooLarge", async () => {
    const tip = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "x\n");
    const move: RelayMove = { ref: MAIN, from: null, to: tip };
    const pack = await relayPack(source, move);
    const atCap = await relayPack(source, move, { maxPackBytes: pack.length });
    expect(atCap.length).toBe(pack.length);
    const over = await relayPack(source, move, { maxPackBytes: pack.length - 1 }).catch(
      (cause: unknown) => cause,
    );
    expect(over).toBeInstanceOf(PackTooLarge);
    expect(over).toMatchObject({ bytes: pack.length, limit: pack.length - 1 });
  });

  it("[relay.pack-bytes-streamed] the streamed count is the buffered pack's length, wherever the answer's chunks end", async () => {
    const base = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "x\n");
    const tip = commitFile(repos.source.dir, "noise.txt", noise(40_000), base);
    const whole = await uploadPack(source, [tip], []);
    const thin = await uploadPack(source, [tip], [base]);
    // Several side-band packets, so a pkt-line's length and its band byte each fall on a chunk's edge somewhere.
    expect(whole.length).toBeGreaterThan(3 * 65_515);
    expect(await uploadPackBytes(source, [tip], [])).toBe(whole.length);
    expect(await uploadPackBytes(source, [tip], [base])).toBe(thin.length);
    for (const size of [1, 2, 3, 5, 4096, 65_519, 65_520, 65_521])
      expect(await uploadPackBytes(inChunksOf(source, size), [tip], []), `chunks of ${size}`).toBe(
        whole.length,
      );
  });

  it("[relay.pack-bytes-refuses] the streamed count throws where the buffered fetch throws: an error band, a stray line, a cut answer, no pack", async () => {
    const tip = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "x\n");
    const packed = pkt(Uint8Array.from([1, ...enc.encode("PACK"), 0, 0, 0, 2, 0, 0, 0, 0]));
    const answers: readonly (readonly [string, Uint8Array, RegExp])[] = [
      [
        "an error band",
        concat([pkt("NAK\n"), packed, pkt(Uint8Array.from([3, ...enc.encode("no such commit")]))]),
        /upload-pack error: no such commit/,
      ],
      [
        "a stray line",
        concat([pkt("NAK\n"), pkt("hello\n"), packed, FLUSH]),
        /unexpected upload-pack line/,
      ],
      ["a cut answer", concat([pkt("NAK\n"), packed.subarray(0, packed.length - 3)]), /truncated/],
      ["no pack", concat([pkt("NAK\n"), FLUSH]), /without a pack/],
    ];
    for (const [, answer, message] of answers) {
      for (const remote of [answering(answer), inChunksOf(answering(answer), 1)])
        await expect(uploadPackBytes(remote, [tip], [])).rejects.toThrow(message);
      await expect(uploadPack(answering(answer), [tip], [])).rejects.toThrow(message);
    }
    // The same pack, whole, counts: twelve bytes of header and no trailer here.
    expect(await uploadPackBytes(answering(concat([pkt("NAK\n"), packed, FLUSH])), [tip], [])).toBe(
      12,
    );
  });

  it("[relay.cap-streamed] an answer over the cap is abandoned as it streams, never read whole", async () => {
    let pulled = 0;
    const endless: GitRemote = {
      ...source,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 16_384;
              if (pulled > 8 * 1024 * 1024) controller.close();
              else controller.enqueue(new Uint8Array(16_384));
            },
          }),
        ),
    };
    const tip = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "x\n");
    await expect(uploadPack(endless, [tip], [], { maxBytes: 1024 })).rejects.toBeInstanceOf(
      PackTooLarge,
    );
    expect(pulled).toBeLessThan(256 * 1024);
  });

  it("[sync.upload-pack] fetches only what the haves lack", async () => {
    const base = headOf(repos.source.dir) ?? commitFile(repos.source.dir, "a.txt", "x\n");
    const tip = commitFile(repos.source.dir, "c.txt", "tip only\n", base);
    const whole = await uploadPack(source, [tip], []);
    const delta = await uploadPack(source, [tip], [base]);
    // tip's commit, tree and blob; the whole history holds more.
    expect(count(delta)).toBe(3);
    expect(count(whole)).toBeGreaterThan(count(delta));
  });
});
