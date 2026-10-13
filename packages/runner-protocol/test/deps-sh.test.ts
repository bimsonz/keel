import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEPS_DROP_SH, DEPS_FETCH_SH, DEPS_KEEP_SH, DEPS_PACK_SH } from "../src/index.ts";

/**
 * Every case runs the real POSIX functions through sh, tar, gzip, split and
 * curl, so its time is process spawns, which a loaded machine stretches far
 * past vitest's 5 s default. The bound is the property files' 60 s: it
 * catches a hang, not a slow machine.
 *
 * The tools are the machine's own: BSD's on macOS, GNU's on Linux and in a
 * box. Every case here holds on both. Where the two tools would part ways
 * were the function written otherwise, the case says which tool does what.
 */
vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((s) => new Promise((done) => s.close(() => done(undefined)))),
  );
});

const scratchDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Bytes gzip cannot shrink, so an archive of them is as long as they are. */
const noise = (bytes: number) => randomBytes(bytes);

type Entry =
  | { readonly file: Uint8Array | string; readonly executable?: boolean }
  | { readonly link: string };

/** Writes a tree: each path a file, or a symlink to `link` (which need not exist). */
const plant = (root: string, entries: Readonly<Record<string, Entry>>) => {
  for (const [path, entry] of Object.entries(entries)) {
    const at = join(root, path);
    mkdirSync(dirname(at), { recursive: true });
    if ("link" in entry) symlinkSync(entry.link, at);
    else {
      writeFileSync(at, entry.file);
      if (entry.executable === true) chmodSync(at, 0o755);
    }
  }
  return root;
};

/**
 * A candidate after an install, as pnpm leaves one: the store's copies under
 * `.pnpm`, relative symlinks to them from the root and from a workspace
 * package, a bin, a link that points nowhere, and source files beside them.
 */
const installed = (): Readonly<Record<string, Entry>> => ({
  "package.json": { file: "{}\n" },
  "src/index.ts": { file: "export {};\n" },
  "packages/web/src/app.ts": { file: "export const app = 1;\n" },
  "packages/Zed/src/zed.ts": { file: "export const zed = 1;\n" },
  "node_modules/.pnpm/left@1.0.0/node_modules/left/index.js": { file: "module.exports = 1;\n" },
  "node_modules/.pnpm/left@1.0.0/node_modules/left/blob.bin": { file: noise(40_000) },
  "node_modules/.pnpm/left@1.0.0/node_modules/left/node_modules/inner/i.js": { file: "inner\n" },
  "node_modules/.pnpm/tool@2.0.0/node_modules/tool/cli.js": {
    file: "#!/usr/bin/env node\n",
    executable: true,
  },
  "node_modules/left": { link: ".pnpm/left@1.0.0/node_modules/left" },
  "node_modules/.bin/tool": { link: "../.pnpm/tool@2.0.0/node_modules/tool/cli.js" },
  "node_modules/dangling": { link: "../nowhere/at-all" },
  "node_modules/a name with spaces/f.js": { file: "spaced\n" },
  "packages/web/node_modules/left": {
    link: "../../../node_modules/.pnpm/left@1.0.0/node_modules/left",
  },
  "packages/web/node_modules/.cache/kept.bin": { file: noise(9_000) },
  "packages/Zed/node_modules/tool": {
    link: "../../../node_modules/.pnpm/tool@2.0.0/node_modules/tool",
  },
});

/** Everything under `root`, by path: a directory, a file's hash and whether it runs, or a link's target. */
const snapshot = (root: string, dir = root): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir).flatMap((name): [string, string][] => {
      const at = join(dir, name);
      const path = at.slice(root.length + 1);
      const stat = lstatSync(at);
      if (stat.isSymbolicLink()) return [[path, `link ${readlinkSync(at)}`]];
      if (stat.isDirectory()) return [[path, "dir"], ...Object.entries(snapshot(root, at))];
      return [[path, `file ${sha256(readFileSync(at))}${(stat.mode & 0o111) === 0 ? "" : " x"}`]];
    }),
  );

/** The part of a snapshot that is inside a `node_modules`: what a deps bundle carries. */
const depsOf = (tree: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(tree).filter(([path]) => `/${path}/`.includes("/node_modules/")),
  );

const sourceOf = (tree: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(tree).filter(
      ([path, what]) => !`/${path}/`.includes("/node_modules/") && what !== "dir",
    ),
  );

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a script through sh without blocking the test's own HTTP server. Its
 * standard input holds `stdin` and then ends, so a tool that reads it never
 * waits.
 */
const sh = (
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
  stdin = "",
): Promise<Ran> =>
  new Promise((done, failed) => {
    const child = spawn("sh", ["-c", script, ...args], {
      env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", ...env },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    // A script that never reads its input may be gone before it is all written.
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
    child.on("error", failed);
    child.on("close", (status) =>
      done({
        status,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
  });

interface Packed {
  readonly status: number | null;
  readonly stdout: string;
  readonly out: string;
  /** The reported file count, and each part as reported: its hash, its size and its bytes. */
  readonly files: number;
  readonly parts: readonly {
    readonly sha256: string;
    readonly bytes: number;
    readonly body: Buffer;
  }[];
}

/** Runs `keel_deps_pack` on `dir`, as the deps box does after its install. */
const pack = async (
  dir: string,
  partBytes: number,
  env: NodeJS.ProcessEnv = {},
): Promise<Packed> => {
  const out = join(scratchDir("keel-deps-out-"), "parts");
  const ran = await sh(
    `${DEPS_PACK_SH}\nkeel_deps_pack "$0" "$1" "$2"`,
    [dir, out, String(partBytes)],
    env,
  );
  const lines = ran.stdout.split("\n").filter(Boolean);
  const names = existsSync(out) ? readdirSync(out).toSorted() : [];
  const reported = lines.flatMap((line) => {
    const [, hash, size] = /^part ([0-9a-f]{64}) ([0-9]+)$/.exec(line) ?? [];
    return hash === undefined ? [] : [{ sha256: hash, bytes: Number(size) }];
  });
  return {
    status: ran.status,
    stdout: ran.stdout,
    out,
    files: Number(/^files ([0-9]+)$/.exec(lines[0] ?? "")?.[1] ?? Number.NaN),
    parts:
      ran.status === 0
        ? reported.map((p, i) => ({ ...p, body: readFileSync(join(out, names[i] ?? "")) }))
        : [],
  };
};

const SIGNATURE = "S".repeat(86);

/**
 * A deps host on 127.0.0.1: it answers `GET /<namespace>/<sha256>` with what
 * `stored` holds under that hash, 404 otherwise, and keeps every URL asked.
 */
const depsHost = async (stored: ReadonlyMap<string, Uint8Array>) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const body = stored.get(
      new URL(request.url ?? "/", "http://host").pathname.split("/").at(-1) ?? "",
    );
    if (body === undefined) response.writeHead(404).end();
    else response.writeHead(200, { "content-length": body.length }).end(body);
  });
  servers.push(server);
  await new Promise((listening) => server.listen(0, "127.0.0.1", () => listening(undefined)));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the host has no port");
  return {
    requests,
    /** A part's URL as Keel signs it: the hash last, then the expiry and the signature. */
    url: (sha256Hex: string) =>
      `http://127.0.0.1:${address.port}/usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0/${sha256Hex}?exp=1800000000&sig=${SIGNATURE}`,
  };
};

/**
 * Runs `keel_deps_fetch` as a suite command does: the URLs in one variable,
 * expanded unquoted under `set -f`, since each holds a `?`.
 */
const fetchInto = async (dir: string, urls: readonly string[]) => {
  const scratch = scratchDir("keel-deps-scratch-");
  const ran = await sh(
    `${DEPS_FETCH_SH}\nset -f\nkeel_deps_fetch "$0" "$1" $KEEL_DEPS_PARTS`,
    [scratch, dir],
    { KEEL_DEPS_PARTS: urls.join(" ") },
  );
  return { ...ran, scratch };
};

/** A suite box's workspace before its deps arrive: the candidate's source, and no `node_modules`. */
const workspaceOf = (tree: Readonly<Record<string, Entry>>) =>
  plant(
    scratchDir("keel-deps-ws-"),
    Object.fromEntries(Object.entries(tree).filter(([path]) => !path.includes("node_modules"))),
  );

const servedBy = (parts: Packed["parts"]) => new Map(parts.map((p) => [p.sha256, p.body]));

describe("packing a candidate's deps", () => {
  it("[deps.sh.pack] packs every node_modules that is not inside another, in bytewise order, with symlinks kept and nothing else", async () => {
    const dir = plant(scratchDir("keel-deps-src-"), installed());
    const packed = await pack(dir, 1024 * 1024);
    expect(packed.status).toBe(0);
    expect(packed.parts).toHaveLength(1);
    const archive = join(scratchDir("keel-deps-tar-"), "deps.tgz");
    writeFileSync(archive, Buffer.concat(packed.parts.map((p) => p.body)));
    const listed = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((path) => path.replace(/^\.\//, "").replace(/\/$/, ""));
    expect(listed.toSorted()).toEqual(Object.keys(depsOf(snapshot(dir))).toSorted());
    // Bytewise: `packages/Zed` before `packages/web`, where a locale would put `web` first.
    const tops = listed.filter(
      (path) => path.endsWith("node_modules") && !path.includes("node_modules/"),
    );
    expect(tops).toEqual([
      "node_modules",
      "packages/Zed/node_modules",
      "packages/web/node_modules",
    ]);
    const links = Object.values(depsOf(snapshot(dir))).filter((what) => what.startsWith("link "));
    const files = Object.values(depsOf(snapshot(dir))).filter((what) => what.startsWith("file "));
    expect(links).toHaveLength(5);
    expect(packed.files).toBe(files.length + links.length);
  });

  it("[deps.sh.split] splits the archive at the size asked, and reports each part by its own sha256 and size, in order", async () => {
    const dir = plant(scratchDir("keel-deps-src-"), installed());
    const packed = await pack(dir, 8192);
    expect(packed.status).toBe(0);
    expect(packed.parts.length).toBeGreaterThan(5);
    expect(readdirSync(packed.out).toSorted()).toEqual(
      packed.parts.map((_, i) => `part-${String(i).padStart(4, "0")}`),
    );
    for (const part of packed.parts) {
      expect(part.body.length).toBe(part.bytes);
      expect(sha256(part.body)).toBe(part.sha256);
    }
    const full = packed.parts.slice(0, -1);
    expect(full.map((part) => part.bytes)).toEqual(full.map(() => 8192));
    expect(packed.parts.at(-1)?.bytes).toBeGreaterThan(0);
    expect(packed.parts.at(-1)?.bytes).toBeLessThanOrEqual(8192);
    // The parts, joined in order, are one whole archive.
    const whole = await pack(dir, 64 * 1024 * 1024);
    expect(whole.parts).toHaveLength(1);
    expect(packed.parts.reduce((n, p) => n + p.bytes, 0)).toBe(whole.parts[0]?.bytes);
    const archive = join(scratchDir("keel-deps-tar-"), "deps.tgz");
    writeFileSync(archive, Buffer.concat(packed.parts.map((p) => p.body)));
    execFileSync("gzip", ["-t", archive]);
  });

  it("[deps.sh.pack-refuses] refuses a tree with no node_modules, a directory that is not there, and an archive tar did not finish", async () => {
    const bare = plant(scratchDir("keel-deps-src-"), { "src/index.ts": { file: "export {};\n" } });
    expect(await pack(bare, 8192)).toMatchObject({ status: 1, stdout: "no-node-modules\n" });
    expect(await pack(join(bare, "absent"), 8192)).toMatchObject({
      status: 1,
      stdout: "pack-failed\n",
    });
    // A tar that writes half an archive and fails: sh has no pipefail, so only its kept exit code tells.
    const dir = plant(scratchDir("keel-deps-src-"), installed());
    const bin = scratchDir("keel-deps-bin-");
    writeFileSync(join(bin, "tar"), "#!/bin/sh\nhead -c 30000 /dev/urandom\nexit 2\n");
    chmodSync(join(bin, "tar"), 0o755);
    const failed = await pack(dir, 8192, { PATH: `${bin}:${process.env["PATH"]}` });
    expect(failed).toMatchObject({ status: 1, stdout: "pack-failed\n" });
  });
});

describe("fetching a deps bundle into a workspace", () => {
  it("[deps.sh.round-trip] puts back exactly what was packed: nested node_modules, relative and dangling symlinks, an executable", async () => {
    const dir = plant(scratchDir("keel-deps-src-"), installed());
    const packed = await pack(dir, 8192);
    const host = await depsHost(servedBy(packed.parts));
    const workspace = workspaceOf(installed());
    const fetched = await fetchInto(
      workspace,
      packed.parts.map((p) => host.url(p.sha256)),
    );
    expect(fetched).toMatchObject({ status: 0, stdout: "" });
    expect(snapshot(workspace)).toEqual(snapshot(dir));
    // The links still lead where they led, and the bin still runs.
    expect(readFileSync(join(workspace, "packages/web/node_modules/left/index.js"), "utf8")).toBe(
      "module.exports = 1;\n",
    );
    expect(readlinkSync(join(workspace, "node_modules/dangling"))).toBe("../nowhere/at-all");
    expect(
      lstatSync(join(workspace, "node_modules/.pnpm/tool@2.0.0/node_modules/tool/cli.js")).mode &
        0o111,
    ).not.toBe(0);
    // Each part was asked for once, in order, by its signed URL; nothing fetched is left behind.
    expect(host.requests).toEqual(
      packed.parts.map(
        (p) => `GET ${new URL(host.url(p.sha256)).pathname}?exp=1800000000&sig=${SIGNATURE}`,
      ),
    );
    expect(existsSync(join(fetched.scratch, "deps"))).toBe(false);
  });

  it("[deps.sh.part-checked] refuses a part that is not the one its URL names, a whole archive of another tree, and extracts nothing", async () => {
    const good = await pack(plant(scratchDir("keel-deps-src-"), installed()), 1024 * 1024);
    const other = await pack(
      plant(scratchDir("keel-deps-src-"), { "node_modules/evil/index.js": { file: "evil\n" } }),
      1024 * 1024,
    );
    const [wanted, served] = [good.parts[0], other.parts[0]];
    if (wanted === undefined || served === undefined) throw new Error("nothing was packed");
    // A whole, valid deps archive, but not this one: only its sha256 can tell.
    const host = await depsHost(new Map([[wanted.sha256, served.body]]));
    const workspace = workspaceOf(installed());
    const before = snapshot(workspace);
    const fetched = await fetchInto(workspace, [host.url(wanted.sha256)]);
    expect(fetched).toMatchObject({ status: 1, stdout: "part-hash-mismatch\n" });
    expect(snapshot(workspace)).toEqual(before);
    expect(`${fetched.stdout}${fetched.stderr}`).not.toContain(SIGNATURE);
  });

  it("[deps.sh.part-checked] refuses a bundle whose last part is corrupt, with nothing of the parts before it extracted", async () => {
    const packed = await pack(plant(scratchDir("keel-deps-src-"), installed()), 8192);
    const last = packed.parts.at(-1);
    if (last === undefined) throw new Error("nothing was packed");
    const corrupt = Buffer.from(last.body);
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0xff;
    const host = await depsHost(new Map([...servedBy(packed.parts), [last.sha256, corrupt]]));
    const workspace = workspaceOf(installed());
    const before = snapshot(workspace);
    const fetched = await fetchInto(
      workspace,
      packed.parts.map((p) => host.url(p.sha256)),
    );
    expect(fetched).toMatchObject({ status: 1, stdout: "part-hash-mismatch\n" });
    expect(snapshot(workspace)).toEqual(before);
    expect(host.requests).toHaveLength(packed.parts.length);
  });

  it("[deps.sh.fetch-failed] refuses a bundle with a part the host does not have, and extracts nothing", async () => {
    const packed = await pack(plant(scratchDir("keel-deps-src-"), installed()), 8192);
    const stored = servedBy(packed.parts);
    stored.delete(packed.parts[2]?.sha256 ?? "");
    const host = await depsHost(stored);
    const workspace = workspaceOf(installed());
    const before = snapshot(workspace);
    const fetched = await fetchInto(
      workspace,
      packed.parts.map((p) => host.url(p.sha256)),
    );
    expect(fetched).toMatchObject({ status: 1, stdout: "fetch-failed\n" });
    expect(snapshot(workspace)).toEqual(before);
    expect(`${fetched.stdout}${fetched.stderr}`).not.toContain(SIGNATURE);
  });

  it("[deps.sh.no-parts] refuses to fetch a bundle of no parts", async () => {
    const workspace = workspaceOf(installed());
    const before = snapshot(workspace);
    expect(await fetchInto(workspace, [])).toMatchObject({ status: 1, stdout: "no-parts\n" });
    expect(snapshot(workspace)).toEqual(before);
  });

  it("[deps.sh.extract-failed] refuses parts that are each what their URL names and together no archive", async () => {
    const junk = [noise(5_000), noise(5_000)];
    const host = await depsHost(new Map(junk.map((bytes) => [sha256(bytes), bytes])));
    const workspace = workspaceOf(installed());
    const before = snapshot(workspace);
    const fetched = await fetchInto(
      workspace,
      junk.map((bytes) => host.url(sha256(bytes))),
    );
    expect(fetched).toMatchObject({ status: 1, stdout: "extract-failed\n" });
    expect(snapshot(workspace)).toEqual(before);
  });
});

describe("dropping fetched deps", () => {
  it("[deps.sh.drop] removes every node_modules, nested ones and their symlinks with them, and leaves the source", async () => {
    const dir = plant(scratchDir("keel-deps-src-"), installed());
    const source = sourceOf(snapshot(dir));
    expect(Object.keys(depsOf(snapshot(dir))).length).toBeGreaterThan(10);
    const dropped = await sh(`${DEPS_DROP_SH}\nkeel_deps_drop "$0"`, [dir]);
    expect(dropped).toMatchObject({ status: 0, stdout: "" });
    expect(depsOf(snapshot(dir))).toEqual({});
    expect(sourceOf(snapshot(dir))).toEqual(source);
    expect(Object.keys(source).toSorted()).toEqual([
      "package.json",
      "packages/Zed/src/zed.ts",
      "packages/web/src/app.ts",
      "src/index.ts",
    ]);
    // A tree with none is left as it is.
    expect(await sh(`${DEPS_DROP_SH}\nkeel_deps_drop "$0"`, [dir])).toMatchObject({ status: 0 });
    expect(sourceOf(snapshot(dir))).toEqual(source);
  });
});

/**
 * A candidate as a deps box extracts one: the files an install reads, and
 * beside them what no install may see (the bundle's own manifest, a pnpmfile,
 * source and a vendored directory).
 */
const extracted = (): Readonly<Record<string, Entry>> => ({
  ".npmrc": { file: "hoist=false\n" },
  "package.json": { file: '{"name":"root"}\n' },
  "packages/tool/bin/tool.js": { file: "#!/usr/bin/env node\n", executable: true },
  "packages/tool/package.json": { file: '{"name":"tool","bin":"bin/tool.js"}\n' },
  "pnpm-lock.yaml": { file: "lockfileVersion: '9.0'\n" },
  ".keel-bundle.sha256": { file: "the bundle's manifest\n" },
  ".pnpmfile.cjs": { file: "module.exports = {};\n" },
  "packages/web/src/app.ts": { file: "export const app = 1;\n" },
  "src/index.ts": { file: "export {};\n" },
  "vendor/x/index.js": { file: 'module.exports = "vendored";\n' },
});

/** The sha256 of each file of `extracted()` an install reads, written out. */
const NPMRC = "d94d573d5aa644cdd09ff46d9b9c5e9b59185533420308c9a55ad5dc3176f22b";
const ROOT = "420943fabf1f783b7a487f3c3a5065ef88cafd461bd9480d9eb363974d0914d0";
const TOOL_BIN = "a59c47872b71f12589942892464e764c0db350c20b72228645615cc36e0a0725";
const TOOL = "85fbbdfbef9e6c2ff35f624af4b9caef2f9aa22554faafad625f116d15ee70b3";
const LOCK = "f0bcde463fa201480015b9caa7db2017d3c1b6ca9c7e133df955038c54333d48";

/** The install inputs of `extracted()`: the format's line, then a `<sha256>  <path>` line per file. */
const INPUTS = [
  "keel.install/1",
  `${NPMRC}  .npmrc`,
  `${ROOT}  package.json`,
  `${TOOL_BIN}  packages/tool/bin/tool.js`,
  `${TOOL}  packages/tool/package.json`,
  `${LOCK}  pnpm-lock.yaml`,
  "",
].join("\n");

/** The sha256 of `INPUTS`, written out: the install digest. */
const INSTALL = "edc6729490265336a6b76622fc4d4a80b90dddbcded1d19c244d18173aa88b34";

const hashOf = (text: string | Uint8Array) =>
  sha256(typeof text === "string" ? Buffer.from(text) : text);

/** Install inputs that list these lines after the format's own. */
const listing = (...lines: readonly string[]) => ["keel.install/1", ...lines, ""].join("\n");

/**
 * A PATH on which each tool named is a stand-in: a script of these lines,
 * which finds the machine's own tool at `$OWN` and a log to write to at
 * `$CALLS`. Answers the environment to run under, and the log's lines.
 */
const standIns = (tools: Readonly<Record<string, readonly string[]>>) => {
  const bin = scratchDir("keel-deps-bin-");
  const log = join(bin, "calls.log");
  for (const [tool, lines] of Object.entries(tools)) {
    const own = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, tool),
      ["#!/bin/sh", `OWN="${own}"; CALLS="${log}"`, ...lines, ""].join("\n"),
    );
    chmodSync(join(bin, tool), 0o755);
  }
  return {
    env: { PATH: `${bin}:${process.env["PATH"]}` },
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
  };
};

/**
 * Runs `keel_deps_keep` in `tree`, as a deps box does once a candidate is
 * extracted there: the inputs in a file of its scratch (no file when
 * undefined), asked for `install` (the inputs' own sha256 unless given), the
 * files kept in `out` (`<scratch>/kept` unless given). `env` and `stdin` are
 * what the function runs under and is fed.
 */
const keep = async (
  tree: string,
  inputs: string | Uint8Array | undefined,
  over: {
    readonly install?: string;
    readonly scratch?: string;
    readonly out?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly stdin?: string;
  } = {},
) => {
  const scratch = over.scratch ?? scratchDir("keel-deps-keep-");
  if (inputs !== undefined) writeFileSync(join(scratch, "inputs"), inputs);
  const out = over.out ?? join(scratch, "kept");
  const ran = await sh(
    `${DEPS_KEEP_SH}\ncd "$0" && keel_deps_keep "$1" "$2" "$3"`,
    [tree, join(scratch, "inputs"), over.install ?? hashOf(inputs ?? ""), out],
    over.env,
    over.stdin,
  );
  return {
    status: ran.status,
    stdout: ran.stdout,
    stderr: ran.stderr,
    scratch,
    kept: existsSync(out) ? snapshot(out) : undefined,
  };
};

/** A stand-in that writes down what it was asked, then does it. */
const recorded = (tool: string) => [`echo "${tool} $*" >>"$CALLS"`, 'exec "$OWN" "$@"'];

/** A stand-in that says on stderr every argument it is handed, then does its work. */
const loud = (tool: string) => [
  `echo ${tool} >>"$CALLS"`,
  `echo "${tool}: $*" >&2`,
  'exec "$OWN" "$@"',
];

/** A tree with a file beside it that is not the candidate's. */
const beside = () =>
  plant(scratchDir("keel-deps-root-"), {
    "outside.json": { file: "not the candidate's\n" },
    "tree/package.json": { file: '{"name":"root"}\n' },
    "tree/packages/tool/package.json": { file: '{"name":"tool","bin":"bin/tool.js"}\n' },
    "tree/pnpm-lock.yaml": { file: "lockfileVersion: '9.0'\n" },
  });

/** Inputs refused before anything is moved: the one reason, nothing a tool said, and no kept files. */
const MISMATCH = { status: 1, stdout: "install-mismatch\n", stderr: "", kept: undefined };

describe("keeping the files a candidate's install digest covers", () => {
  it("[deps.keep.kept] moves exactly the listed files to their own paths, an executable still one, and nothing else of the tree", async () => {
    const tree = plant(scratchDir("keel-deps-tree-"), extracted());
    // What an earlier keep left in the same place is no part of this one.
    const scratch = plant(scratchDir("keel-deps-keep-"), {
      "kept/package.json": { file: "an earlier candidate's\n" },
      "kept/vendor/x/index.js": { file: "an earlier candidate's\n" },
    });
    const kept = await keep(tree, INPUTS, { install: INSTALL, scratch });
    expect(kept).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(kept.kept).toEqual({
      ".npmrc": `file ${NPMRC}`,
      "package.json": `file ${ROOT}`,
      packages: "dir",
      "packages/tool": "dir",
      "packages/tool/bin": "dir",
      "packages/tool/bin/tool.js": `file ${TOOL_BIN} x`,
      "packages/tool/package.json": `file ${TOOL}`,
      "pnpm-lock.yaml": `file ${LOCK}`,
    });
    // Moved, not copied: the tree is left with what no install may read.
    expect(Object.keys(sourceOf(snapshot(tree))).toSorted()).toEqual([
      ".keel-bundle.sha256",
      ".pnpmfile.cjs",
      "packages/web/src/app.ts",
      "src/index.ts",
      "vendor/x/index.js",
    ]);
  });

  it("[deps.keep.digest] refuses inputs that are not the ones the digest names, and no inputs at all", async () => {
    const tree = plant(scratchDir("keel-deps-tree-"), extracted());
    const before = snapshot(tree);
    // The same files, listed for another digest: one of another text, one a digit off, and none.
    const installs = [hashOf(`${INPUTS}\n`), `0${INSTALL.slice(1)}`, ""];
    expect(
      await Promise.all(
        installs.map(async (install) => ({ install, ...(await keep(tree, INPUTS, { install })) })),
      ),
    ).toMatchObject(installs.map((install) => ({ install, ...MISMATCH })));
    expect(await keep(tree, undefined, { install: INSTALL })).toMatchObject(MISMATCH);
    expect(await keep(tree, undefined, { install: "" })).toMatchObject(MISMATCH);
    expect(snapshot(tree)).toEqual(before);
  });

  it("[deps.keep.format] refuses inputs whose first line is not the format's", async () => {
    const tree = plant(scratchDir("keel-deps-tree-"), extracted());
    const before = snapshot(tree);
    const lines = [`${ROOT}  package.json`, `${LOCK}  pnpm-lock.yaml`, ""];
    const each = [
      ["keel.install/2", ...lines].join("\n"),
      ["keel.install/1 ", ...lines].join("\n"),
      ["", "keel.install/1", ...lines].join("\n"),
      // No first line of its own: the list alone, whose first file would go unread.
      lines.join("\n"),
    ];
    expect(
      await Promise.all(each.map(async (inputs) => ({ inputs, ...(await keep(tree, inputs)) }))),
    ).toMatchObject(each.map((inputs) => ({ inputs, ...MISMATCH })));
    expect(snapshot(tree)).toEqual(before);
  });

  it("[deps.keep.empty] refuses inputs that list no file", async () => {
    const tree = plant(scratchDir("keel-deps-tree-"), extracted());
    const before = snapshot(tree);
    // GNU's `sha256sum -c` refuses a list of no lines itself. BSD's passes one, so on macOS
    // nothing but the function's own check of the list stands between these and a kept nothing.
    const each = ["keel.install/1\n", "keel.install/1", ""];
    expect(
      await Promise.all(each.map(async (inputs) => ({ inputs, ...(await keep(tree, inputs)) }))),
    ).toMatchObject(each.map((inputs) => ({ inputs, ...MISMATCH })));
    expect(snapshot(tree)).toEqual(before);
  });

  it("[deps.keep.absent] refuses inputs that list a file the tree does not hold, and moves none of the others", async () => {
    const tree = plant(scratchDir("keel-deps-tree-"), extracted());
    rmSync(join(tree, "packages/tool/package.json"));
    const before = snapshot(tree);
    expect(await keep(tree, INPUTS, { install: INSTALL })).toMatchObject(MISMATCH);
    // And one that was never the candidate's, listed last, after files that are all there.
    const never = listing(
      `${ROOT}  package.json`,
      `${LOCK}  pnpm-lock.yaml`,
      `${TOOL}  x/package.json`,
    );
    expect(await keep(tree, never)).toMatchObject(MISMATCH);
    expect(snapshot(tree)).toEqual(before);
  });

  it("[deps.keep.differs] refuses a tree whose listed file has other bytes than its line says", async () => {
    const tree = plant(scratchDir("keel-deps-tree-"), extracted());
    writeFileSync(
      join(tree, "packages/tool/package.json"),
      '{"name":"tool","bin":"bin/other.js"}\n',
    );
    const before = snapshot(tree);
    expect(await keep(tree, INPUTS, { install: INSTALL })).toMatchObject(MISMATCH);
    expect(snapshot(tree)).toEqual(before);
  });

  it("[deps.keep.strict] refuses inputs with a line that is not a file's sha256 and its path, though every other line is", async () => {
    const tree = plant(scratchDir("keel-deps-tree-"), extracted());
    const before = snapshot(tree);
    const each = [
      // A path with no hash would otherwise be kept unchecked.
      "pnpm-lock.yaml",
      `${LOCK.slice(1)}  pnpm-lock.yaml`,
      `${"z".repeat(64)}  pnpm-lock.yaml`,
      "",
      // Shapes a `sha256sum -c` reads as this file's line, GNU's and BSD's alike, and the
      // move would read as another path: a binary marker, one space, the tagged form, an
      // escaped name, capital hex.
      `${LOCK} *pnpm-lock.yaml`,
      `${LOCK} pnpm-lock.yaml`,
      `SHA256 (pnpm-lock.yaml) = ${LOCK}`,
      `\\${LOCK}  pnpm-lock.yaml`,
      `${LOCK.toUpperCase()}  pnpm-lock.yaml`,
    ];
    expect(
      await Promise.all(
        each.map(async (line) => ({
          line,
          ...(await keep(tree, listing(`${ROOT}  package.json`, line, `${NPMRC}  .npmrc`))),
        })),
      ),
    ).toMatchObject(each.map((line) => ({ line, ...MISMATCH })));
    expect(snapshot(tree)).toEqual(before);
  });

  it("[deps.keep.paths] keeps a file at its path as it is written: spaces, two together, one first or last, a backslash, a letter that is not ASCII", async () => {
    const odd: Readonly<Record<string, Entry>> = {
      "a b/package.json": { file: "spaced\n" },
      "c  d/package.json": { file: "two spaces\n" },
      " lead/package.json": { file: "a space first\n" },
      "packages/tool/bin/tool ": { file: "a space last\n" },
      "back\\slash/package.json": { file: "a backslash\n" },
      "café/package.json": { file: "an accent\n" },
      "pnpm-lock.yaml": { file: "lockfileVersion: '9.0'\n" },
    };
    const tree = plant(scratchDir("keel-deps-tree-"), {
      ...odd,
      // Files a line read short of its whole path would name instead.
      "d/package.json": { file: "after the second space\n" },
      "lead/package.json": { file: "without its first space\n" },
      "packages/tool/bin/tool": { file: "without its last space\n" },
      "backslash/package.json": { file: "without its backslash\n" },
    });
    const kept = await keep(
      tree,
      listing(
        `${hashOf("a space first\n")}   lead/package.json`,
        `${hashOf("spaced\n")}  a b/package.json`,
        `${hashOf("a backslash\n")}  back\\slash/package.json`,
        `${hashOf("two spaces\n")}  c  d/package.json`,
        `${hashOf("an accent\n")}  café/package.json`,
        `${hashOf("a space last\n")}  packages/tool/bin/tool `,
        `${LOCK}  pnpm-lock.yaml`,
      ),
    );
    expect(kept).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(kept.kept).toEqual(snapshot(plant(scratchDir("keel-deps-tree-"), odd)));
  });

  it("[deps.keep.failed] says so when a listed file cannot be moved, or the kept files' place cannot be made, and passes on nothing the tool said of it", async () => {
    // Listed twice: there both times it is checked, gone the second time it is moved.
    const twice = await keep(
      plant(scratchDir("keel-deps-tree-"), extracted()),
      listing(`${ROOT}  package.json`, `${LOCK}  pnpm-lock.yaml`, `${ROOT}  package.json`),
    );
    expect(twice).toMatchObject({ status: 1, stdout: "keep-failed\n", stderr: "" });
    // A place under a regular file is no directory's.
    const tree = plant(scratchDir("keel-deps-tree-"), extracted());
    const before = snapshot(tree);
    const scratch = plant(scratchDir("keel-deps-keep-"), { flat: { file: "a file\n" } });
    const unmade = await keep(tree, INPUTS, { scratch, out: join(scratch, "flat/kept") });
    expect(unmade).toMatchObject({ status: 1, stdout: "keep-failed\n", stderr: "" });
    expect(snapshot(tree)).toEqual(before);
  });

  it("[deps.keep.quiet] passes on nothing its tools say: what they say names the candidate's paths", async () => {
    const tree = plant(scratchDir("keel-deps-tree-"), extracted());
    // Tools that say on stderr every argument they are handed, and then do their work.
    const tools = standIns({
      sha256sum: loud("sha256sum"),
      rm: loud("rm"),
      mkdir: loud("mkdir"),
      mv: loud("mv"),
    });
    const kept = await keep(tree, INPUTS, { install: INSTALL, env: tools.env });
    expect(kept).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(Object.keys(kept.kept ?? {})).toContain("packages/tool/bin/tool.js");
    // Each of the four was the stand-in, and had its say.
    expect([...new Set(tools.calls())].toSorted()).toEqual(["mkdir", "mv", "rm", "sha256sum"]);
  });

  it("[deps.keep.inside] refuses a listed path that leaves the tree before it hashes any listed file, and moves nothing to or from outside it", async () => {
    const outside = hashOf("not the candidate's\n");
    const each = await Promise.all(
      [
        // A file beside the tree, listed with the sha256 it does have.
        () => `${outside}  ../outside.json`,
        () => `${outside}  packages/../../outside.json`,
        (root: string) => `${outside}  ${join(root, "outside.json")}`,
        // Out of a directory and back to a file of the tree: a path is held to its segments, not to where it lands.
        () => `${ROOT}  packages/../package.json`,
        () => `${ROOT}  packages/tool/../../package.json`,
      ].map(async (lineOf) => {
        const root = beside();
        const line = lineOf(root);
        const before = snapshot(root);
        const tools = standIns({ sha256sum: recorded("sha256sum") });
        const kept = await keep(join(root, "tree"), listing(line, `${LOCK}  pnpm-lock.yaml`), {
          env: tools.env,
        });
        return { line, kept, before, after: snapshot(root), hashed: tools.calls() };
      }),
    );
    for (const { line, kept, before, after, hashed } of each) {
      expect({ line, ...kept }).toMatchObject({ line, ...MISMATCH });
      expect({ line, after }).toEqual({ line, after: before });
      // Nothing beside the kept files' place but the inputs it was handed and its own list of them.
      expect(readdirSync(kept.scratch).toSorted()).toEqual(["inputs", "inputs.lines"]);
      // The one thing hashed is the inputs: no file their list names was opened, inside the tree or out.
      expect({ line, hashed }).toEqual({
        line,
        hashed: [`sha256sum ${join(kept.scratch, "inputs")}`],
      });
    }
  });

  it("[deps.keep.bytes] judges a list's lines as bytes, whatever the locale: a `..` after a byte that is no letter of it is a `..` still", async () => {
    const root = beside();
    // 0xff is in no UTF-8 text. Under a UTF-8 locale, GNU's grep and BSD's alike, a pattern's
    // `.` matches no such byte, so a `..` behind one goes unseen unless the lines are read as bytes.
    const inputs = Buffer.concat([
      Buffer.from(`keel.install/1\n${hashOf("not the candidate's\n")}  bad`),
      Buffer.from([0xff]),
      Buffer.from(`/../../outside.json\n${LOCK}  pnpm-lock.yaml\n`),
    ]);
    const tools = standIns({
      sha256sum: recorded("sha256sum"),
      grep: ['echo "grep under LC_ALL=${LC_ALL:-}" >>"$CALLS"', 'exec "$OWN" "$@"'],
    });
    const before = snapshot(root);
    const kept = await keep(join(root, "tree"), inputs, {
      env: { ...tools.env, LC_ALL: "C.UTF-8" },
    });
    expect(kept).toMatchObject(MISMATCH);
    expect(snapshot(root)).toEqual(before);
    // Both patterns ran under the C locale, and the list was refused by them: no file it names was hashed.
    expect(tools.calls()).toEqual([
      `sha256sum ${join(kept.scratch, "inputs")}`,
      "grep under LC_ALL=C",
      "grep under LC_ALL=C",
    ]);
  });

  it("[deps.keep.locale] checks every listed file whatever the locale: a path that is no text of it stops no tool short of the files after it", async () => {
    // `€` is three bytes that are no Big5 character. Under that locale BSD's sed stops at its
    // line ("illegal byte sequence"), so a list read in the locale's letters is refused whatever
    // the tree holds: the second half is what holds the sed to bytes. GNU's sed passes them on.
    const euro = '{"name":"euro"}\n';
    const inputs = listing(
      `${hashOf(euro)}  €/package.json`,
      `${ROOT}  package.json`,
      `${LOCK}  pnpm-lock.yaml`,
    );
    const env = { LC_ALL: "zh_TW.Big5" };
    const held = { ...extracted(), "€/package.json": { file: euro } };
    // A lockfile of other bytes than its line says, listed after the path.
    const tree = plant(scratchDir("keel-deps-tree-"), {
      ...held,
      "pnpm-lock.yaml": { file: "another lockfile\n" },
    });
    const before = snapshot(tree);
    expect(await keep(tree, inputs, { env })).toMatchObject(MISMATCH);
    expect(snapshot(tree)).toEqual(before);
    // And a tree that is what the list says is kept, that path with it.
    const kept = await keep(plant(scratchDir("keel-deps-tree-"), held), inputs, { env });
    expect(kept).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(kept.kept).toMatchObject({
      "€/package.json": `file ${hashOf(euro)}`,
      "package.json": `file ${ROOT}`,
      "pnpm-lock.yaml": `file ${LOCK}`,
    });
  });

  it("[deps.keep.judged] refuses a list whose lines could not be judged: a grep that fails has not found them good", async () => {
    // Each of the two patterns in turn, answered as a grep answers that could not read its file.
    const each = await Promise.all(
      ["-qvE", "-qE"].map(async (flags) => {
        const tree = plant(scratchDir("keel-deps-tree-"), extracted());
        const before = snapshot(tree);
        const tools = standIns({
          grep: [
            `[ "$1" != ${flags} ] || { echo "${flags} failed" >>"$CALLS"; exit 2; }`,
            'exec "$OWN" "$@"',
          ],
        });
        const kept = await keep(tree, INPUTS, { install: INSTALL, env: tools.env });
        return { flags, kept, before, after: snapshot(tree), failed: tools.calls() };
      }),
    );
    for (const { flags, kept, before, after, failed } of each) {
      expect({ flags, ...kept }).toMatchObject({ flags, ...MISMATCH });
      expect({ flags, after }).toEqual({ flags, after: before });
      expect(failed).toEqual([`${flags} failed`]);
    }
  });

  it("[deps.keep.whole] refuses a list that was not rewritten whole: a sed that stops part way has left the lines after it unchecked", async () => {
    // A sed that writes the first line as it should, then dies saying what it was handed. Piped
    // to the check, its status is lost and the check passes on that one line.
    const dying = {
      sed: [
        'echo "sed stopped" >>"$CALLS"',
        '"$OWN" "$@" | head -n 1',
        'echo "sed: $*" >&2',
        "exit 1",
      ],
    };
    // A tree that is what the list says, and one whose lockfile, listed last, has other bytes.
    const trees = [
      extracted(),
      { ...extracted(), "pnpm-lock.yaml": { file: "another lockfile\n" } },
    ];
    for (const files of trees) {
      const tree = plant(scratchDir("keel-deps-tree-"), files);
      const before = snapshot(tree);
      const tools = standIns(dying);
      expect(await keep(tree, INPUTS, { install: INSTALL, env: tools.env })).toMatchObject(
        MISMATCH,
      );
      expect(snapshot(tree)).toEqual(before);
      expect(tools.calls()).toEqual(["sed stopped"]);
    }
    // The same stand-in with nothing wrong with it keeps the tree: the refusal is the status's.
    const tools = standIns({ sed: recorded("sed") });
    const kept = await keep(plant(scratchDir("keel-deps-tree-"), extracted()), INPUTS, {
      install: INSTALL,
      env: tools.env,
    });
    expect(kept).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(tools.calls()).toHaveLength(1);
  });

  it("[deps.keep.dash] keeps a file whose path starts with a dash, or is one: a path is never an option of a tool, nor its standard input", async () => {
    const dashed: Readonly<Record<string, Entry>> = {
      // Named as options a mv has. GNU's answers `--help` and exits 0 with nothing moved, and
      // fails on the others; BSD's fails on all three.
      "--help": { file: "#!/usr/bin/env node\n", executable: true },
      "-n": { file: "a command\n" },
      "-t/package.json": { file: '{"name":"dashed"}\n' },
      // And as what a `sha256sum -c`, GNU's or BSD's, reads its standard input for.
      "-": { file: "a dash\n" },
      "pnpm-lock.yaml": { file: "lockfileVersion: '9.0'\n" },
    };
    const planted = () =>
      plant(scratchDir("keel-deps-tree-"), { ...dashed, "src/index.ts": { file: "export {};\n" } });
    const kept = await keep(
      planted(),
      listing(
        `${hashOf("a dash\n")}  -`,
        `${TOOL_BIN}  --help`,
        `${hashOf("a command\n")}  -n`,
        `${hashOf('{"name":"dashed"}\n')}  -t/package.json`,
        `${LOCK}  pnpm-lock.yaml`,
      ),
    );
    expect(kept).toMatchObject({ status: 0, stdout: "", stderr: "" });
    expect(kept.kept).toEqual(snapshot(plant(scratchDir("keel-deps-tree-"), dashed)));
    // The file `-` listed with the sha256 of what the function is fed, not of what the file holds:
    // it is the file that is hashed, so it is refused and not kept unchecked.
    const tree = planted();
    const before = snapshot(tree);
    const fed = await keep(
      tree,
      listing(`${hashOf("what the box was fed\n")}  -`, `${LOCK}  pnpm-lock.yaml`),
      { stdin: "what the box was fed\n" },
    );
    expect(fed).toMatchObject(MISMATCH);
    expect(snapshot(tree)).toEqual(before);
  });

  it("[deps.keep.unterminated] refuses inputs whose last line has no newline after it, and moves nothing: a line cut short is no line", async () => {
    const tree = plant(scratchDir("keel-deps-tree-"), extracted());
    const before = snapshot(tree);
    // Every listed file is there with its hash; only the end of the text is missing.
    const cut = ["keel.install/1", `${ROOT}  package.json`, `${LOCK}  pnpm-lock.yaml`].join("\n");
    expect(await keep(tree, cut)).toMatchObject(MISMATCH);
    expect(snapshot(tree)).toEqual(before);
  });
});
