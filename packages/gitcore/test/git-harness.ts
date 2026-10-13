// Node-only harness: real git repositories in temp dirs, a `git cat-file
// --batch` object reader for gitcore, and a fast-import writer for generated
// histories.

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissingObject, type TreeReader } from "../src/diff.ts";
import { type CommitInfo, decodeCommit, decodeTree, type TreeEntry } from "../src/objects.ts";

/**
 * Every git child's environment. Its one config file turns auto-maintenance
 * off: a fetch or a receive-pack otherwise starts `git maintenance run --auto
 * --detach`, which from git 2.54 repacks after its command has returned and
 * re-creates files in a repo the test is removing (ENOTEMPTY on the temp
 * directory, on CI).
 */
export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(import.meta.dirname, "harness.gitconfig"),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

/** No synchronous git call may outlast this: a hung child fails its case instead of holding a worker. */
export const GIT_TIMEOUT_MS = 120_000;

/** A git child that outlived its timeout and was killed by the harness: a failed case, never a crash of git's. */
export class GitTimedOut extends Error {
  constructor(
    readonly subcommand: string,
    readonly timeoutMs: number,
  ) {
    super(`git ${subcommand} timed out after ${timeoutMs} ms and was killed`);
    this.name = "GitTimedOut";
  }
}

export interface GitSyncOptions {
  readonly cwd?: string | undefined;
  readonly input?: string | Uint8Array | undefined;
  readonly maxBuffer?: number | undefined;
  readonly timeoutMs?: number | undefined;
  /** Variables set over GIT_ENV for this child (and every git it starts). */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** The subcommand of a git command line, past its `-c key=value` pairs and flags. */
const subcommandOf = (args: readonly string[]): string => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "-c") i++;
    else if (!arg.startsWith("-")) return arg;
  }
  return args.join(" ");
};

/**
 * The one door to a synchronous git child, for every test here. The child is
 * killed at its timeout and the call throws GitTimedOut; any other failure to
 * run it (git missing, more output than `maxBuffer`) throws too. What comes
 * back is a git that ran to its own end: an exit status, or the signal it
 * died on by itself.
 */
export function gitSync(args: string[], opts: GitSyncOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const run = spawnSync("git", args, {
    cwd: opts.cwd,
    env: opts.env === undefined ? GIT_ENV : { ...GIT_ENV, ...opts.env },
    input: opts.input,
    maxBuffer: opts.maxBuffer ?? 1 << 28,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (run.error !== undefined) {
    if ("code" in run.error && run.error.code === "ETIMEDOUT")
      throw new GitTimedOut(subcommandOf(args), timeoutMs);
    throw run.error;
  }
  return run;
}

export function git(cwd: string, args: string[], input?: string | Uint8Array): string {
  const run = gitSync(args, { cwd, input });
  if (run.status !== 0)
    throw new Error(
      `git ${args.join(" ")} failed (${run.status ?? run.signal}): ${run.stderr.toString()}`,
    );
  return run.stdout.toString();
}

/** The gits GitCore's merges are proven against: 2.50.1 (histogram as through 2.53) and 2.55.0 (2.54 on re-diffs groups compaction moved). */
const ORACLE_RANGE = { from: [2, 50], to: [2, 55] } as const;

/** The git a differential compares with: its version, and whether it re-diffs moved groups (2.54 on). */
export interface OracleGit {
  readonly version: string;
  readonly rediffsMovedGroups: boolean;
}

/** Reads `git --version` once and refuses a git the differentials were never proven against. */
export function oracleGit(): OracleGit {
  const version = git(process.cwd(), ["--version"]).trim();
  const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
  const at = major * 1000 + minor;
  const { from, to } = ORACLE_RANGE;
  if (at < from[0] * 1000 + from[1] || at > to[0] * 1000 + to[1])
    throw new Error(
      `oracle git out of range: ${version}; GitCore is proven against git ${from.join(".")}–${to.join(".")}`,
    );
  console.log(`ORACLE ${version}`);
  return { version, rediffsMovedGroups: at >= 2054 };
}

export function tempRepo(bare = true): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gitcore-"));
  git(dir, ["init", "-q", ...(bare ? ["--bare"] : []), "-b", "main"]);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A fetch that answers smart-HTTP requests from local bare repos, as a git
 * server would: `<base>/<name>/git-upload-pack` and `/git-receive-pack` run
 * the matching `--stateless-rpc` service on `repos[name]`. `requests` counts
 * every call, so a test can see that nothing was sent.
 */
export function smartHttp(repos: Readonly<Record<string, string>>) {
  const served = { requests: 0 };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    served.requests += 1;
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const [, name, service] =
      /^\/([^/]+)\/(git-upload-pack|git-receive-pack)$/.exec(url.pathname) ?? [];
    const dir = name === undefined ? undefined : repos[name];
    if (dir === undefined || service === undefined)
      return new Response("no such repo", { status: 404 });
    const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
    const run = gitSync([service.slice("git-".length), "--stateless-rpc", dir], {
      input: body,
      maxBuffer: 1 << 30,
    });
    if (run.status !== 0) return new Response(run.stderr, { status: 500 });
    return new Response(new Uint8Array(run.stdout), { status: 200 });
  };
  return { fetch, served };
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
  /** `Name <email> <seconds> <offset>`; the committer's identity when absent. */
  author?: string;
}

/** Feed commits to `git fast-import`; returns mark -> commit oid. */
export function fastImport(dir: string, commits: CommitPlan[]): Map<number, string> {
  const chunks: Buffer[] = [];
  const w = (s: string | Uint8Array) =>
    chunks.push(typeof s === "string" ? Buffer.from(s) : Buffer.from(s));
  for (const c of commits) {
    w(`reset ${c.ref}\n`);
    w(`commit ${c.ref}\nmark :${c.mark}\n`);
    if (c.author !== undefined) w(`author ${c.author}\n`);
    w("committer t <t@example.com> 1700000000 +0000\n");
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
  const r = gitSync(["fast-import", "--quiet", "--force", `--export-marks=${marksFile}`], {
    cwd: dir,
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
 * `mergeBase` names the base commit instead of letting git find one.
 */
export function gitMergeTree(
  dir: string,
  ours: string,
  theirs: string,
  mergeBase?: string,
): GitMerge {
  const base = mergeBase === undefined ? [] : [`--merge-base=${mergeBase}`];
  const r = gitSync(["merge-tree", "--write-tree", ...base, ours, theirs], { cwd: dir });
  if (r.status === null && r.signal !== null)
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

// ------------------------------------------------------------ ssh signing

/** ssh-keygen under the same timeout and kill as every git child; answers what it wrote, or throws with what it said. */
export function sshKeygen(args: string[], input?: Uint8Array): Buffer {
  const run = spawnSync("ssh-keygen", args, {
    input,
    maxBuffer: 1 << 24,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0)
    throw new Error(
      `ssh-keygen ${args[0] ?? ""} ${args[1] ?? ""} failed (${run.status ?? run.signal}): ${run.stderr.toString()}`,
    );
  return run.stdout;
}

const sshString = (bytes: Uint8Array | string) => {
  const body = Buffer.from(bytes);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
};

const fromBase64Url = (text: string | undefined) => Buffer.from(text ?? "", "base64url");

/**
 * A fresh Ed25519 key in the two forms a signing test needs: PKCS#8 PEM, as
 * GitCore imports it, and an unencrypted OpenSSH key file in `dir`, as
 * ssh-keygen reads it (PROTOCOL.key: `openssh-key-v1`, cipher and KDF `none`).
 * `publicKey` is ssh-keygen's own reading of that file.
 */
export function sshKeyPair(
  dir: string,
  name: string,
): { readonly pkcs8Pem: string; readonly keyFile: string; readonly publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = fromBase64Url(jwk.d);
  const pub = fromBase64Url(jwk.x);
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  const check = Buffer.from([1, 2, 3, 4]);
  const secret = Buffer.concat([
    check,
    check,
    sshString("ssh-ed25519"),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(""),
  ]);
  const padding = Buffer.from(
    Array.from({ length: (8 - (secret.length % 8)) % 8 }, (_, i) => i + 1),
  );
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    Buffer.from([0, 0, 0, 1]),
    sshString(blob),
    sshString(Buffer.concat([secret, padding])),
  ]);
  const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
  const keyFile = join(dir, name);
  writeFileSync(
    keyFile,
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
  );
  chmodSync(keyFile, 0o600);
  const [type = "", key = ""] = sshKeygen(["-y", "-f", keyFile]).toString().trim().split(" ");
  return {
    pkcs8Pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    keyFile,
    publicKey: `${type} ${key}`,
  };
}
