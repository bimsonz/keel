// Node-only harness: real git repositories in temp dirs, a `git cat-file
// --batch` object reader for gitcore, and a fast-import writer for generated
// histories.

import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissingObject, type TreeReader } from "../src/diff.ts";
import { type CommitInfo, decodeCommit, decodeTree, type TreeEntry } from "../src/objects.ts";

export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

export function git(cwd: string, args: string[], input?: string | Uint8Array): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, input, maxBuffer: 1 << 28 }).toString();
}

export function tempRepo(bare = true): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gitcore-"));
  git(dir, ["init", "-q", ...(bare ? ["--bare"] : []), "-b", "main"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Pipelined `git cat-file --batch`; responses come back in request order. */
export class CatFileReader implements TreeReader {
  private proc: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private waiting: Array<{
    resolve: (v: { type: string; body: Uint8Array }) => void;
    reject: (e: Error) => void;
  }> = [];
  reads = 0;

  constructor(dir: string) {
    this.proc = spawn("git", ["cat-file", "--batch"], { cwd: dir, env: GIT_ENV });
    this.proc.stdout.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
  }

  private drain() {
    for (;;) {
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0 || this.waiting.length === 0) return;
      const header = this.buf.subarray(0, nl).toString();
      const parts = header.split(" ");
      if (parts[1] === "missing") {
        this.buf = this.buf.subarray(nl + 1);
        this.waiting.shift()?.reject(new MissingObject(parts[0] ?? ""));
        continue;
      }
      const size = Number(parts[2]);
      if (this.buf.length < nl + 1 + size + 1) return;
      const body = new Uint8Array(this.buf.subarray(nl + 1, nl + 1 + size));
      this.buf = this.buf.subarray(nl + 1 + size + 1);
      this.waiting.shift()?.resolve({ type: parts[1] ?? "", body });
    }
  }

  read(oid: string): Promise<{ type: string; body: Uint8Array }> {
    this.reads++;
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.proc.stdin.write(`${oid}\n`);
    });
  }

  async readTree(oid: string): Promise<TreeEntry[]> {
    const o = await this.read(oid);
    if (o.type !== "tree") throw new Error(`${oid} is a ${o.type}`);
    return decodeTree(o.body);
  }
  async readCommit(oid: string): Promise<CommitInfo> {
    const o = await this.read(oid);
    if (o.type !== "commit") throw new Error(`${oid} is a ${o.type}`);
    return decodeCommit(o.body);
  }
  async readBlob(oid: string): Promise<Uint8Array> {
    const o = await this.read(oid);
    if (o.type !== "blob") throw new Error(`${oid} is a ${o.type}`);
    return o.body;
  }
  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

// ------------------------------------------------------------ fast-import

export type Mode = "100644" | "100755" | "120000" | "160000";
export interface FileSpec {
  mode: Mode;
  /** For 160000, the 40-hex commit id. */
  data: Uint8Array | string;
}
export type TreeModel = Map<string, FileSpec>;

export interface CommitPlan {
  mark: number;
  ref: string;
  parents: number[];
  tree: TreeModel;
  message: string;
}

/** Feed commits to `git fast-import`; returns mark -> commit oid. */
export function fastImport(dir: string, commits: CommitPlan[]): Map<number, string> {
  const chunks: Buffer[] = [];
  const w = (s: string | Uint8Array) =>
    chunks.push(typeof s === "string" ? Buffer.from(s) : Buffer.from(s));
  for (const c of commits) {
    w(`reset ${c.ref}\n`);
    w(`commit ${c.ref}\nmark :${c.mark}\ncommitter t <t@example.com> 1700000000 +0000\n`);
    const msg = Buffer.from(c.message);
    w(`data ${msg.length}\n`);
    w(msg);
    w("\n");
    c.parents.forEach((p, i) => w(`${i === 0 ? "from" : "merge"} :${p}\n`));
    w("deleteall\n");
    for (const [path, f] of [...c.tree.entries()].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
      if (f.mode === "160000") {
        w(`M 160000 ${String(f.data)} ${path}\n`);
        continue;
      }
      const data = typeof f.data === "string" ? Buffer.from(f.data) : Buffer.from(f.data);
      w(`M ${f.mode} inline ${path}\ndata ${data.length}\n`);
      w(data);
      w("\n");
    }
    w("\n");
  }
  const marksFile = join(dir, `marks-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const r = spawnSync("git", ["fast-import", "--quiet", "--force", `--export-marks=${marksFile}`], {
    cwd: dir,
    env: GIT_ENV,
    input: Buffer.concat(chunks),
  });
  if (r.status !== 0) throw new Error(`fast-import failed: ${r.stderr.toString()}`);
  const marks = new Map<number, string>();
  for (const line of readFileSync(marksFile, "utf8").split("\n")) {
    const m = /^:(\d+) ([0-9a-f]{40})$/.exec(line);
    if (m?.[2] !== undefined) marks.set(Number(m[1]), m[2]);
  }
  rmSync(marksFile);
  return marks;
}

// ------------------------------------------------------------ merge-tree

export type GitMerge =
  /** The merged tree git wrote (with conflict markers when `conflicted`). */
  | { readonly outcome: "clean" | "conflicted"; readonly tree: string; readonly output: string }
  /**
   * git died on a signal instead of answering. git 2.50's merge-ort aborts on
   * an assertion when a criss-cross's virtual base meets a gitlink and a
   * symlink at one path (`handle_content_merge`, merge-ort.c:2153): there is
   * no tree to compare with, so GitCore must refuse such a history.
   */
  | { readonly outcome: "crashed"; readonly signal: string; readonly stderr: string };

/**
 * `git merge-tree --write-tree ours theirs`: exit 0 is clean, 1 is conflicted,
 * death by a signal is a crash; anything else (git missing, a bad argument) fails.
 */
export function gitMergeTree(dir: string, ours: string, theirs: string): GitMerge {
  const r = spawnSync("git", ["merge-tree", "--write-tree", ours, theirs], {
    cwd: dir,
    env: GIT_ENV,
  });
  if (r.error === undefined && r.status === null && r.signal !== null)
    return { outcome: "crashed", signal: r.signal, stderr: r.stderr.toString() };
  if (r.status !== 0 && r.status !== 1)
    throw new Error(`merge-tree failed (${r.status}): ${r.stderr.toString()}`);
  const output = r.stdout.toString();
  return {
    outcome: r.status === 1 ? "conflicted" : "clean",
    tree: output.split("\n")[0] ?? "",
    output,
  };
}
