// The MergeBox scripts against real git: what GitCore refuses is composed by
// git's own merge-tree, member by member on each member's base, chained and
// pushed to staging's scratch ref; a conflict is refused with its paths, and a
// git that dies by a signal is told apart from both. The remotes here are
// paths: in the box they are HTTPS, with the token added on the way out.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MemberRefused, restack } from "../src/compose.ts";
import {
  BOX_CANARY_FILE,
  BOX_CHECK_CAP_BYTES,
  BOX_COMPOSE_SCRIPT,
  boxComposeArgs,
  type BoxMember,
  readBoxCompose,
  scanBoxCheck,
} from "../src/mergebox-script.ts";
import {
  CatFileReader,
  type CommitPlan,
  fastImport,
  git,
  gitMergeTree,
  oracleGit,
  scriptSync,
  tempRepo,
  type TreeModel,
} from "./git-harness.ts";

oracleGit();

const file = (data: string, mode: "100644" | "100755" = "100644") => ({ mode, data });
const GUIDE = Array.from({ length: 40 }, (_, i) => `line ${i} of the guide\n`).join("");
const BASE: TreeModel = new Map([
  ["README", file("readme\n")],
  ["src/a.ts", file("export const a = 1;\n")],
  ["run.sh", file("#!/bin/sh\necho run\n")],
  ["docs/guide.md", file(GUIDE)],
]);
const KEEL = {
  name: "Keel",
  email: "keel@keel.invalid",
  time: 1_760_000_000,
};

const home = mkdtempSync(join(tmpdir(), "mergebox-home-"));
const repos: { cleanup: () => void }[] = [];
afterAll(() => {
  for (const repo of repos) repo.cleanup();
  rmSync(home, { recursive: true, force: true });
});

/** A bare repo that serves any reachable object by id, as Artifacts does. */
function served() {
  const repo = tempRepo();
  repos.push(repo);
  git(repo.dir, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
  return repo.dir;
}

/** Staging at trunk's head (BASE), and a workspaces repo holding BASE and each member's head on it. */
function world(members: ((t: TreeModel) => void)[]) {
  const staging = served();
  const workspaces = served();
  const trunk: CommitPlan = {
    mark: 1,
    ref: "refs/heads/main",
    parents: [],
    tree: BASE,
    message: "base\n",
  };
  const base = fastImport(staging, [trunk]).get(1) ?? "";
  const plans = members.map((change, i): CommitPlan => {
    const tree = new Map(BASE);
    change(tree);
    return { mark: i + 2, ref: `refs/heads/ws/${i}`, parents: [1], tree, message: `ws ${i}\n` };
  });
  const marks = fastImport(workspaces, [trunk, ...plans]);
  const heads = plans.map((p) => marks.get(p.mark) ?? "");
  const boxMembers: BoxMember[] = heads.map((head) => ({ remote: workspaces, base, head }));
  return { staging, workspaces, base, heads, members: boxMembers };
}

/** Runs the compose script as the box does, with `path` ahead of the PATH when given. */
function compose(
  staging: string,
  base: string,
  scratch: string,
  members: BoxMember[],
  path?: string,
) {
  const run = scriptSync(
    "bash",
    ["-c", BOX_COMPOSE_SCRIPT, "box", ...boxComposeArgs(staging, base, scratch, members)],
    {
      ...process.env,
      HOME: home,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "keel-mergebox",
      GIT_AUTHOR_EMAIL: "mergebox@keel.invalid",
      GIT_COMMITTER_NAME: "keel-mergebox",
      GIT_COMMITTER_EMAIL: "mergebox@keel.invalid",
      ...(path === undefined ? {} : { PATH: `${path}:${process.env["PATH"] ?? ""}` }),
    },
  );
  return {
    exitCode: run.status ?? -1,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

const refsUnder = (dir: string, prefix: string) =>
  git(dir, ["for-each-ref", "--format=%(refname)", prefix]).trim().split("\n").filter(Boolean);

describe("the MergeBox compose script", () => {
  it("[mergebox.script] composes a mode change and a similar rename with an edit, which GitCore refuses, as git's merge-tree does, chained and pushed to the scratch ref, sweeping a leftover", async () => {
    const w = world([
      // The first changes run.sh's mode and the guide's first line.
      (t) => {
        t.set("run.sh", file("#!/bin/sh\necho run\n", "100755"));
        t.set("docs/guide.md", file(GUIDE.replace("line 0 of", "line zero of")));
      },
      // The second changes run.sh's content, and moves the guide with one more line at its end.
      (t) => {
        t.set("run.sh", file("#!/bin/sh\necho run\necho done\n"));
        t.delete("docs/guide.md");
        t.set("docs/manual.md", file(`${GUIDE}one more line\n`));
      },
    ]);
    // GitCore composes the first and refuses the second on what the first changed; git merges both.
    const reader = new CatFileReader(w.workspaces);
    const refused = await restack(
      reader,
      w.base,
      w.heads.map((head) => ({ base: w.base, head, message: "m\n", trailers: [] })),
      KEEL,
    ).catch((e: unknown) => e);
    reader.close();
    expect(refused).toBeInstanceOf(MemberRefused);
    expect(refused).toMatchObject({ member: 1 });
    git(w.staging, ["update-ref", "refs/keel/box/c0", w.base]);

    const run = compose(w.staging, w.base, "refs/keel/box/c1", w.members);
    expect({ exitCode: run.exitCode, stderr: run.stderr }).toMatchObject({ exitCode: 0 });
    const read = readBoxCompose(run.exitCode, run.stdout, 2);
    if (read.kind !== "composed")
      throw new Error(`expected composed, read ${JSON.stringify(read)}`);
    expect(run.stdout).toContain("swept 1\n");
    expect(refsUnder(w.staging, "refs/keel/box/")).toEqual(["refs/keel/box/c1"]);

    // The chain on staging: one commit per member over the base, each holding the tree reported.
    const chain = git(w.staging, [
      "rev-list",
      "--reverse",
      "--parents",
      `${w.base}..refs/keel/box/c1`,
    ])
      .trim()
      .split("\n")
      .map((line) => line.split(" "));
    expect(chain.map(([, parent]) => parent)).toEqual([w.base, chain[0]?.[0]]);
    expect(chain.at(-1)?.[0]).toBe(read.tip);
    expect(chain.map(([oid]) => git(w.staging, ["rev-parse", `${oid}^{tree}`]).trim())).toEqual(
      read.trees,
    );

    // Each tree is git's merge of that member on its own base, onto the chain so far.
    git(w.workspaces, ["fetch", "-q", w.staging, "refs/keel/box/c1:refs/keel/box/c1"]);
    expect(gitMergeTree(w.workspaces, w.base, w.heads[0] ?? "", w.base)).toMatchObject({
      outcome: "clean",
      tree: read.trees[0],
    });
    expect(gitMergeTree(w.workspaces, chain[0]?.[0] ?? "", w.heads[1] ?? "", w.base)).toMatchObject(
      {
        outcome: "clean",
        tree: read.trees[1],
      },
    );
    const listing = git(w.staging, ["ls-tree", "-r", read.tip]);
    expect(listing).toMatch(/^100755 blob [0-9a-f]{40}\trun\.sh$/m);
    expect(listing).toMatch(/\tdocs\/manual\.md$/m);
    expect(listing).not.toMatch(/\tdocs\/guide\.md$/m);
  });

  it("[mergebox.script] refuses a true conflict with the member and its paths, and pushes nothing", () => {
    const w = world([
      (t) => t.set("src/a.ts", file("export const a = 10;\n")),
      (t) => t.set("src/a.ts", file("export const a = 20;\n")),
    ]);
    const run = compose(w.staging, w.base, "refs/keel/box/c2", w.members);
    expect(run.exitCode).toBe(1);
    expect(readBoxCompose(run.exitCode, run.stdout, 2)).toEqual({
      kind: "refused",
      member: 1,
      paths: ["src/a.ts"],
    });
    expect(refsUnder(w.staging, "refs/keel/box/")).toEqual([]);
  });

  it("[mergebox.git-crash] a git that dies by a signal is read as crashed, not as a refusal or the box's transport", () => {
    const w = world([(t) => t.set("run.sh", file("#!/bin/sh\necho run\n", "100755"))]);
    const real = scriptSync("sh", ["-c", "command -v git"], process.env).stdout.toString().trim();
    const bin = mkdtempSync(join(tmpdir(), "mergebox-bin-"));
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\n[ "$1" = merge-tree ] && kill -ABRT $$\nexec ${real} "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    try {
      const run = compose(w.staging, w.base, "refs/keel/box/c3", w.members, bin);
      expect(run.exitCode).toBe(134);
      expect(readBoxCompose(run.exitCode, run.stdout, 1)).toEqual({
        kind: "crashed",
        exitCode: 134,
      });
      expect(refsUnder(w.staging, "refs/keel/box/")).toEqual([]);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("the MergeBox check", () => {
  const canary = "art_v9_keelcanary_0f1e2d3c";
  const stream = (parts: { environ?: string; env?: string; files?: Record<string, string> }) =>
    [
      `=== environ\nPATH=/usr/bin\n${parts.environ ?? `KEEL_CANARY=${canary}\n`}`,
      `=== env\nHOME=/root\n${parts.env ?? ""}`,
      `=== files\n${Object.entries(parts.files ?? { [BOX_CANARY_FILE]: `${canary}\n` })
        .map(([path, text]) => `\n--- ${path}\n${text}`)
        .join("")}`,
    ].join("\n");

  it("[mergebox.no-token] passes only with the canary seen where it was planted and no token anywhere", () => {
    const minted = ["art_v1_minted_for_this_compose", "plain-minted-token"];
    expect(scanBoxCheck(stream({}), canary, minted)).toEqual({ canary: "found", tokens: "none" });
    // Blind: the canary not seen in the start environment, or not in its file.
    expect(scanBoxCheck(stream({ environ: "" }), canary, minted)).toEqual({
      kind: "blind",
      missing: ["environ"],
    });
    expect(
      scanBoxCheck(stream({ files: { "/root/box.x/HEAD": "ref\n" } }), canary, minted),
    ).toEqual({
      kind: "blind",
      missing: ["file"],
    });
    // A minted token, whatever its shape, or anything shaped as a token, is found where it is.
    expect(
      scanBoxCheck(
        stream({
          files: { [BOX_CANARY_FILE]: `${canary}\n`, "/root/box.x/config": "plain-minted-token\n" },
        }),
        canary,
        minted,
      ),
    ).toEqual({ kind: "token-found", sections: ["files"] });
    expect(
      scanBoxCheck(stream({ env: "GIT_TOKEN=art_v2_someone_else\n" }), canary, minted),
    ).toEqual({
      kind: "token-found",
      sections: ["env"],
    });
    expect(
      scanBoxCheck(
        stream({ environ: `KEEL_CANARY=${canary}\nGIT_PASSWORD=plain-minted-token\n` }),
        canary,
        minted,
      ),
    ).toEqual({ kind: "token-found", sections: ["environ"] });
    // Over the cap is refused, never passed.
    const big = stream({
      files: { [BOX_CANARY_FILE]: `${canary}\n`, "/root/big": "x".repeat(BOX_CHECK_CAP_BYTES) },
    });
    expect(scanBoxCheck(big, canary, minted)).toMatchObject({ kind: "over-cap" });
  });
});
