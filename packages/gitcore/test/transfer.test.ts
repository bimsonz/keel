// objectsBetween against real git: for generated pairs of trees, a fresh repo
// holding only the first commit must accept a push of a commit with the
// second tree, carrying exactly what objectsBetween found, and then hold
// every object that commit reaches. git receive-pack checks connectivity, so
// a missing object fails the push.
//
// FC_NUM_RUNS sets the number of histories (50 by default) and FC_SEED pins them.

import { afterAll, describe, expect, it } from "vitest";
import { encodeCommit, hashObject } from "../src/objects.ts";
import { writePack } from "../src/pack-write.ts";
import { receivePack } from "../src/push.ts";
import { objectsBetween } from "../src/transfer.ts";
import { historyArb, planCase } from "./gen.ts";
import { CatFileReader, fastImport, git, gitSync, smartHttp, tempRepo } from "./git-harness.ts";
import { fc, PROPERTY_TIMEOUT } from "./support/fast-check.ts";

const RUNS = Number(process.env["FC_NUM_RUNS"] ?? 50);
const DEADLINE_MS = 60_000 + RUNS * 1000;

const source = tempRepo();
const reader = new CatFileReader(source.dir);
afterAll(() => {
  reader.close();
  source.cleanup();
}, DEADLINE_MS);

let caseId = 0;

describe("objectsBetween", { timeout: PROPERTY_TIMEOUT }, () => {
  it(
    "[between.push-complete] a repo holding the first tree accepts the second with only those objects, and lacks nothing after",
    async () => {
      let carried = 0;
      await fc.assert(
        fc.asyncProperty(historyArb, async (h) => {
          caseId += 1;
          const plan = planCase(h, caseId);
          const marks = fastImport(source.dir, plan.commits);
          const [ours, theirs] = [marks.get(plan.oursMark), marks.get(plan.theirsMark)];
          if (ours === undefined || theirs === undefined)
            throw new Error("fast-import lost a mark");
          const [from, to] = await Promise.all([
            reader.readCommit(ours),
            reader.readCommit(theirs),
          ]);

          const target = tempRepo();
          try {
            git(source.dir, ["push", "-q", target.dir, `${ours}:refs/heads/main`]);
            const objects = await objectsBetween(reader, from.tree, to.tree);
            carried += objects.length;
            const who = { name: "t", email: "t@example.com", time: 1_700_000_000 };
            const body = encodeCommit({
              tree: to.tree,
              parents: [ours],
              author: who,
              committer: who,
              message: "theirs on ours\n",
            });
            const commit = await hashObject("commit", body);
            const http = smartHttp({ target: target.dir });
            const outcome = await receivePack(
              { url: "https://git.invalid/target", token: "unused", fetch: http.fetch },
              [{ ref: "refs/heads/main", old: ours, new: commit }],
              await writePack([...objects, { type: "commit", body }]),
            );
            expect(outcome).toEqual({ kind: "applied" });
            const missing = gitSync(["rev-list", "--objects", "--missing=print", commit], {
              cwd: target.dir,
            })
              .stdout.toString()
              .split("\n")
              .filter((line) => line.startsWith("?"));
            expect(missing).toEqual([]);
          } finally {
            target.cleanup();
          }
        }),
        { numRuns: RUNS },
      );
      expect(carried).toBeGreaterThan(0);
    },
    DEADLINE_MS,
  );

  it("[between.same-tree] carries nothing between a tree and itself", async () => {
    const marks = fastImport(source.dir, [
      {
        mark: 1,
        ref: "refs/heads/same",
        parents: [],
        tree: new Map([["a/b.txt", { mode: "100644", data: "b\n" }]]),
        message: "same\n",
      },
    ]);
    const tree = (await reader.readCommit(marks.get(1) ?? "")).tree;
    expect(await objectsBetween(reader, tree, tree)).toEqual([]);
    expect((await objectsBetween(reader, null, tree)).map((o) => o.type).toSorted()).toEqual([
      "blob",
      "tree",
      "tree",
    ]);
  });
});
