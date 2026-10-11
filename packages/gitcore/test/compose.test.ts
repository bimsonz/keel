// restack against real git: a batch is composed onto trunk as one commit per
// member, chained in batch order, and pushed into a staging repo that holds
// only trunk. receive-pack checks connectivity, so a missing object fails the
// push; git merge-tree, given each member's own base, is the oracle for every
// commit's tree (identical, or GitCore refused).
//
// FC_NUM_RUNS sets the number of batches (50 by default) and FC_SEED pins them.

import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { ZERO_OID } from "../src/bytes.ts";
import { FallbackReader, MemberRefused, type RestackMember, restack } from "../src/compose.ts";
import { Refusal } from "../src/merge.ts";
import type { Signature } from "../src/objects.ts";
import { writePack } from "../src/pack-write.ts";
import { receivePack } from "../src/push.ts";
import { batchArb, planBatch } from "./gen.ts";
import {
  CatFileReader,
  type CommitPlan,
  fastImport,
  git,
  GIT_ENV,
  gitMergeTree,
  smartHttp,
  tempRepo,
  type TreeModel,
} from "./git-harness.ts";
import { fc, PROPERTY_TIMEOUT } from "./support/fast-check.ts";

const RUNS = Number(process.env["FC_NUM_RUNS"] ?? 50);
const DEADLINE_MS = 60_000 + RUNS * 1000;

const KEEL: Signature = { name: "Keel", email: "keel@keel.invalid", time: 1_760_000_000 };
const CAND = "refs/heads/cand/c1";

/** Where member heads live: one repo standing for every workspace. */
const workspaces = tempRepo();
const wsReader = new CatFileReader(workspaces.dir);
afterAll(() => {
  wsReader.close();
  workspaces.cleanup();
}, DEADLINE_MS);

const memberOf = (i: number, base: string, head: string): RestackMember => ({
  base,
  head,
  message: `member ${i}\n`,
  trailers: [["Change-Id", `chg_${i}`]],
});

/** A fresh staging repo holding exactly `trunk`, read through its own cat-file. */
function stagingWith(trunk: CommitPlan[]) {
  const repo = tempRepo();
  fastImport(repo.dir, trunk);
  const reader = new CatFileReader(repo.dir);
  return {
    dir: repo.dir,
    reader,
    cleanup: () => {
      reader.close();
      repo.cleanup();
    },
  };
}

/** Pushes the restacked objects to `ref` as a new ref; the ref's old value is zero. */
async function pushTo(
  dir: string,
  ref: string,
  tip: string,
  objects: Parameters<typeof writePack>[0],
) {
  const http = smartHttp({ staging: dir });
  return receivePack(
    { url: "https://git.invalid/staging", token: "unused", fetch: http.fetch },
    [{ ref, old: ZERO_OID, new: tip }],
    await writePack(objects),
  );
}

const run = (dir: string, args: string[]) =>
  spawnSync("git", args, { cwd: dir, env: GIT_ENV, maxBuffer: 1 << 28 });

/** Every object `tip` reaches that the repo lacks, as rev-list prints them. */
const missing = (dir: string, tip: string) =>
  run(dir, ["rev-list", "--objects", "--missing=print", tip])
    .stdout.toString()
    .split("\n")
    .filter((line) => line.startsWith("?"));

const file = (data: string) => ({ mode: "100644" as const, data });
const BASE: TreeModel = new Map([
  ["README", file("readme\n")],
  ["src/a.ts", file("export const a = 1;\n")],
  ["src/b.ts", file("export const b = 2;\n")],
  ["docs/old.md", file("old\n")],
]);
const trunkOf = (tree: TreeModel): CommitPlan[] => [
  { mark: 1, ref: "refs/heads/main", parents: [], tree, message: "base\n" },
];
const edit = (
  mark: number,
  change: (t: TreeModel) => void,
  ref = `refs/heads/ws/${mark}`,
): CommitPlan => {
  const tree = new Map(BASE);
  change(tree);
  return { mark, ref, parents: [1], tree, message: `ws ${mark}\n` };
};

/** Imports base plus each member's head into the workspaces repo; answers base and the heads. */
function seed(members: CommitPlan[]) {
  const marks = fastImport(workspaces.dir, [...trunkOf(BASE), ...members]);
  const at = (mark: number) => {
    const oid = marks.get(mark);
    if (oid === undefined) throw new Error(`fast-import lost mark ${mark}`);
    return oid;
  };
  return { base: at(1), heads: members.map((m) => at(m.mark)) };
}

describe("restack", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[composer.three-changes] composes three disjoint changes as a candidate staging accepts whole", async () => {
    const { base, heads } = seed([
      edit(2, (t) => t.set("src/a.ts", file("export const a = 10;\n"))),
      edit(3, (t) => t.set("lib/new/c.ts", file("export const c = 3;\n"))),
      edit(4, (t) => t.delete("docs/old.md")),
    ]);
    const expected = new Map(BASE);
    expected.set("src/a.ts", file("export const a = 10;\n"));
    expected.set("lib/new/c.ts", file("export const c = 3;\n"));
    expected.delete("docs/old.md");
    const [want] = fastImport(workspaces.dir, [
      { mark: 1, ref: "refs/heads/expected", parents: [], tree: expected, message: "x\n" },
    ]).values();

    const staging = stagingWith(trunkOf(BASE));
    try {
      const reader = new FallbackReader([staging.reader, wsReader]);
      const out = await restack(
        reader,
        base,
        heads.map((h, i) => memberOf(i, base, h)),
        KEEL,
      );
      const tip = out.commits.at(-1)?.oid ?? "";
      expect(await pushTo(staging.dir, CAND, tip, out.objects)).toEqual({ kind: "applied" });
      expect(missing(staging.dir, tip)).toEqual([]);
      const fsck = run(staging.dir, ["fsck", "--strict", "--no-dangling"]);
      expect(fsck.stderr.toString()).toBe("");
      expect(fsck.status).toBe(0);
      expect(out.commits.at(-1)?.tree).toBe((await wsReader.readCommit(want ?? "")).tree);
      // Each commit holds only its own member's change.
      const touched = out.commits.map((c, i) =>
        git(staging.dir, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          i === 0 ? base : (out.commits[i - 1]?.oid ?? ""),
          c.oid,
        ]).trim(),
      );
      expect(touched).toEqual(["src/a.ts", "lib/new/c.ts", "docs/old.md"]);
    } finally {
      staging.cleanup();
    }
  });

  it("[composer.refuses] refuses a batch whose second member edits a path the first changed", async () => {
    const { base, heads } = seed([
      edit(2, (t) => t.set("src/a.ts", file("export const a = 10;\n"))),
      edit(3, (t) => t.set("src/a.ts", file("export const a = 20;\n"))),
    ]);
    const refusal = await restack(
      wsReader,
      base,
      heads.map((h, i) => memberOf(i, base, h)),
      KEEL,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(MemberRefused);
    expect(refusal).toMatchObject({ member: 1, reason: "both-modified", path: "src/a.ts" });
  });

  it("[restack.keeps-author] each restacked commit keeps its submitted commit's author, date and offset, with Keel as committer", async () => {
    const ada = "Ada Lovelace <ada@example.com> 1712345678 +0200";
    const grace = "Grace Hopper <grace@example.org> 1712000000 -0500";
    const authors = [ada, grace];
    const { base, heads } = seed([
      { ...edit(2, (t) => t.set("src/a.ts", file("export const a = 11;\n"))), author: ada },
      { ...edit(3, (t) => t.set("lib/e.ts", file("export const e = 5;\n"))), author: grace },
    ]);
    const staging = stagingWith(trunkOf(BASE));
    try {
      const out = await restack(
        new FallbackReader([staging.reader, wsReader]),
        base,
        heads.map((h, i) => memberOf(i, base, h)),
        KEEL,
      );
      const tip = out.commits.at(-1)?.oid ?? "";
      expect(await pushTo(staging.dir, CAND, tip, out.objects)).toEqual({ kind: "applied" });
      // What git itself reads back from staging, not gitcore's own decoding.
      const identities = out.commits.map((c) =>
        git(staging.dir, [
          "show",
          "-s",
          "--format=%an <%ae> %at %ad%n%cn <%ce> %ct",
          "--date=format:%z",
          c.oid,
        ])
          .trim()
          .split("\n"),
      );
      expect(identities).toEqual(
        authors.map((author) => [author, `Keel <keel@keel.invalid> ${KEEL.time}`]),
      );
    } finally {
      staging.cleanup();
    }
  });

  it("[restack.deterministic] restacks one batch to the same commits and objects every time", async () => {
    const { base, heads } = seed([
      edit(2, (t) => t.set("src/b.ts", file("export const b = 22;\n"))),
      edit(3, (t) => t.set("lib/d.ts", file("export const d = 4;\n"))),
    ]);
    const members = heads.map((h, i) => memberOf(i, base, h));
    const once = await restack(wsReader, base, members, KEEL);
    const again = await restack(new CatFileReader(workspaces.dir), base, members, KEEL);
    expect(again).toEqual(once);
    const later = await restack(wsReader, base, members, { ...KEEL, time: KEEL.time + 1 });
    expect(later.commits.map((c) => c.tree)).toEqual(once.commits.map((c) => c.tree));
    expect(later.commits.at(-1)?.oid).not.toBe(once.commits.at(-1)?.oid);
  });

  it(
    "[composer.one-commit-per-member] chains one commit per member, each tree git's merge on that member's base, or refuses",
    async () => {
      const counts = { composed: 0, multi: 0, refused: 0, steps: 0 };
      let caseId = 0;
      await fc.assert(
        fc.asyncProperty(batchArb, async (batch) => {
          caseId += 1;
          const plan = planBatch(batch, caseId);
          const marks = fastImport(workspaces.dir, plan.commits);
          const at = (mark: number) => marks.get(mark) ?? "";
          const head = at(plan.headMark);
          const members = plan.members.map((m, i) => memberOf(i, at(m.baseMark), at(m.headMark)));
          const staging = stagingWith(plan.trunk);
          try {
            const reader = new FallbackReader([staging.reader, wsReader]);
            const out = await restack(reader, head, members, KEEL).catch((e: unknown) => {
              if (e instanceof Refusal) return null;
              throw e;
            });
            if (out === null) {
              counts.refused += 1;
              return;
            }
            counts.composed += 1;
            if (members.length > 1) counts.multi += 1;
            expect(out.commits).toHaveLength(members.length);
            const tip = out.commits.at(-1)?.oid ?? "";
            const ref = `refs/heads/cand/b${caseId}`;
            expect(await pushTo(staging.dir, ref, tip, out.objects)).toEqual({ kind: "applied" });
            expect(missing(staging.dir, tip)).toEqual([]);
            // The chain: c1's parent is trunk's head, each later commit's the one before.
            const chain = git(staging.dir, [
              "rev-list",
              "--reverse",
              "--parents",
              `${head}..${tip}`,
            ])
              .trim()
              .split("\n");
            expect(chain).toEqual(
              out.commits.map((c, i) => `${c.oid} ${i === 0 ? head : out.commits[i - 1]?.oid}`),
            );
            // git's merge of each step, on the member's own base, from GitCore's previous commit.
            git(workspaces.dir, ["fetch", "-q", staging.dir, `${ref}:${ref}`]);
            for (const [i, m] of members.entries()) {
              counts.steps += 1;
              const ours = i === 0 ? head : (out.commits[i - 1]?.oid ?? "");
              const merged = gitMergeTree(workspaces.dir, ours, m.head, m.base);
              expect(merged, `member ${i}`).toMatchObject({
                outcome: "clean",
                tree: out.commits[i]?.tree,
              });
            }
          } finally {
            staging.cleanup();
          }
        }),
        { numRuns: RUNS },
      );
      console.log(`restack: ${RUNS} batches, ${JSON.stringify(counts)}, 0 wrong`);
      expect(counts.composed).toBeGreaterThan(0);
      expect(counts.multi).toBeGreaterThan(0);
    },
    DEADLINE_MS,
  );
});
