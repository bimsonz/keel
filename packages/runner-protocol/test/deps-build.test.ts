import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BundleFile,
  bundleTexts,
  DEPS_BOX_PATHS,
  DEPS_BUILD_COMMAND,
  DEPS_BUILD_TERMS,
  DEPS_FETCH_SH,
  DEPS_LOCK_SH,
  type DepsBoxPaths,
  type DepsBuildTerms,
  DepsRefused,
  depsBuildCommand,
  depsInputsEncoded,
  sha256Hex,
  writeBundle,
} from "../src/index.ts";

/** Every case runs the real command through sh, curl, tar and the rest: see deps-sh.test.ts. */
vi.setConfig({ testTimeout: 60_000 });

const REPO = join(import.meta.dirname, "../../..");

/**
 * Core's half of a deps build, loaded by its path. This package imports
 * nothing of core and core nothing of it, so no source file can hold the
 * command to the parser that reads its report, or to the inputs it is handed:
 * this test does.
 */
const core: unknown = await import(
  join(REPO, "packages/core/src/application/verification/deps.ts")
);
const coreValue = (name: string): unknown => Reflect.get(Object(core), name);

/** Core's reading of a deps box's stdout. */
const parseDepsBuild = (stdout: string): unknown => {
  const parse = coreValue("parseDepsBuild");
  if (typeof parse !== "function") throw new Error("core exports no parseDepsBuild");
  return parse(stdout);
};

/** Core's install inputs for a bundle's manifest, read with `read`. */
const installInputsOf = (manifest: string, read: (path: string) => string | undefined): unknown => {
  const inputs = coreValue("installInputsOf");
  if (typeof inputs !== "function") throw new Error("core exports no installInputsOf");
  return inputs(manifest, read);
};

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

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A lockfile as pnpm 11 writes one, with these `resolution:` lines for its packages. */
const lockfile = (resolutions: readonly string[]) =>
  [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    // Dependencies that happen to be named like a resolution's fields.
    "      tarball:",
    "        specifier: ^1.0.0",
    "        version: 1.0.0",
    "      repo:",
    "        specifier: ^2.0.0",
    "        version: 2.0.0",
    "",
    "packages:",
    "",
    ...resolutions.flatMap((resolution, i) => [`  pkg-${i}@1.0.0:`, `    ${resolution}`, ""]),
    "snapshots:",
    "",
    // And a package that depends on them, each on a line a resolution's field would be written on.
    "  named-like@1.0.0:",
    "    dependencies:",
    "      directory: 3.0.0",
    "      repo: 2.0.0",
    "      tarball: 1.0.0",
    "",
    ...resolutions.flatMap((_, i) => [`  pkg-${i}@1.0.0: {}`, ""]),
  ].join("\n");

const ON_REGISTRY = [
  "resolution: {integrity: sha512-oSvVPl6ZmkYJ4v5aMEfdvQGVPrWlNPTJ1j6+tUCn5Zb8YIv8G1p3FJ1lX0C2e+/A==}",
  "resolution: {integrity: sha512-abc, tarball: https://registry.npmjs.org/@scope/b/-/b-1.0.0.tgz}",
  // The registry's own tarball of a package that is only named like a local one's field.
  "resolution: {integrity: sha512-def, tarball: https://registry.npmjs.org/directory/-/directory-3.0.0.tgz}",
];

/** Runs `keel_deps_lock` on a lockfile of this text, or on a path that holds none. */
const lockCheck = (text: string | undefined) => {
  const path = join(scratchDir("keel-deps-lock-"), "pnpm-lock.yaml");
  if (text !== undefined) writeFileSync(path, text);
  const ran = spawnSync("sh", ["-c", `${DEPS_LOCK_SH}\nkeel_deps_lock "$0"`, path], {
    encoding: "utf8",
  });
  return { status: ran.status, stdout: ran.stdout };
};

describe("a deps box's lockfile check", () => {
  it("[deps.lock.accepts] passes a lockfile whose every resolution is the public registry's", () => {
    expect(lockCheck(lockfile(ON_REGISTRY))).toEqual({ status: 0, stdout: "" });
    expect(lockCheck(lockfile([]))).toEqual({ status: 0, stdout: "" });
  });

  it("[deps.lock.no-lockfile] refuses a candidate with no lockfile", () => {
    expect(lockCheck(undefined)).toEqual({ status: 1, stdout: "no-lockfile\n" });
  });

  it("[deps.lock.local-directory] refuses a resolution that is a directory of the candidate's own, however it is written", () => {
    for (const resolution of [
      // As pnpm writes a `file:` dependency on a directory, and an injected workspace package.
      "resolution: {directory: vendor/vend, type: directory}",
      "resolution: {type: directory, directory: vendor/vend}",
      // Quoted, as YAML also allows.
      `resolution: {"directory": 'vendor/vend', "type": "directory"}`,
      `"resolution": {directory: vendor/vend, type: directory}`,
      `'resolution': {type: directory, directory: vendor/vend}`,
      // Either field says so alone.
      "resolution: {type: directory}",
      "resolution: {directory: packages/c}",
    ]) {
      // Last, and first among the registry's own: where it stands changes nothing.
      for (const resolutions of [
        [...ON_REGISTRY, resolution],
        [resolution, ...ON_REGISTRY],
      ])
        expect({ resolution, ...lockCheck(lockfile(resolutions)) }).toEqual({
          resolution,
          status: 1,
          stdout: "local-directory\n",
        });
    }
  });

  it("[deps.lock.local-first] says a local directory before anything off the registry, wherever each stands", () => {
    const local = "resolution: {directory: vendor/vend, type: directory}";
    const off = "resolution: {tarball: https://codeload.github.com/o/r/tar.gz/0a1b2c}";
    for (const resolutions of [
      [off, local],
      [local, off],
      [off, ...ON_REGISTRY, local],
      // One resolution that is both.
      [
        "resolution: {directory: vendor/vend, type: directory, tarball: https://evil.example/p.tgz}",
      ],
    ])
      expect({ resolutions, ...lockCheck(lockfile(resolutions)) }).toEqual({
        resolutions,
        status: 1,
        stdout: "local-directory\n",
      });
  });

  it("[deps.lock.registry-only] refuses any resolution off the public registry, naming its host alone", () => {
    for (const [resolution, host] of [
      [
        "resolution: {tarball: https://codeload.github.com/o/r/tar.gz/0a1b2c}",
        "codeload.github.com",
      ],
      ["resolution: {commit: 0a1b2c, repo: https://github.com/o/r.git, type: git}", "github.com"],
      [
        "resolution: {commit: 0a1b2c, repo: git+ssh://git@gitlab.com/o/r.git, type: git}",
        "gitlab.com",
      ],
      ["resolution: {commit: 0a1b2c, repo: git@bitbucket.org:o/r.git, type: git}", "bitbucket.org"],
      [
        "resolution: {integrity: sha512-abc, tarball: https://npm.pkg.github.com/download/@o/p/1.0.0/abc}",
        "npm.pkg.github.com",
      ],
      // A host that only starts like the registry's, and the registry over anything but HTTPS.
      [
        "resolution: {tarball: https://registry.npmjs.org.evil.example/p/-/p-1.0.0.tgz}",
        "registry.npmjs.org.evil.example",
      ],
      ["resolution: {tarball: http://registry.npmjs.org/p/-/p-1.0.0.tgz}", "registry.npmjs.org"],
      // A registry tarball beside a repository is still a repository.
      [
        "resolution: {tarball: https://registry.npmjs.org/p/-/p-1.0.0.tgz, repo: https://evil.example/r, type: git}",
        "evil.example",
      ],
      [
        "resolution: {tarball: https://registry.npmjs.org/p/-/p-1.0.0.tgz, tarball: https://second.example/p.tgz}",
        "second.example",
      ],
      // Quoted, as YAML also allows.
      [`resolution: {"tarball": 'https://quoted.example/p.tgz'}`, "quoted.example"],
      [`"resolution": {tarball: https://quoted-key.example/p.tgz}`, "quoted-key.example"],
      // No host to name, or not written as pnpm writes one.
      ["resolution: {type: git}", "unknown"],
      ["resolution:\n      tarball: https://block.example/p.tgz", "unknown"],
      ["resolution:\n      directory: vendor/vend\n      type: directory", "unknown"],
      ["resolution: {integrity: sha512-abc,", "unknown"],
    ] as const) {
      // Last, and first among the registry's own: where it stands changes nothing.
      for (const resolutions of [
        [...ON_REGISTRY, resolution],
        [resolution, ...ON_REGISTRY],
      ])
        expect({ resolution, ...lockCheck(lockfile(resolutions)) }).toEqual({
          resolution,
          status: 1,
          stdout: `off-registry ${host}\n`,
        });
    }
  });

  it("[deps.lock.host-alone] never prints a URL's credentials, path or query", () => {
    const checked = lockCheck(
      lockfile([
        "resolution: {tarball: https://user:s3cret@evil.example:8443/private/p.tgz?token=t0ken#frag}",
      ]),
    );
    expect(checked).toEqual({ status: 1, stdout: "off-registry evil.example\n" });
  });
});

const enc = new TextEncoder();
const file = (path: string, text: string, executable = false): BundleFile => ({
  path,
  bytes: enc.encode(text),
  ...(executable ? { executable } : {}),
});

const ROOT =
  '{"name":"candidate","packageManager":"pnpm@9.0.0","bin":{"dash":"-","help":"--help"}}\n';
const DASH = "#!/usr/bin/env node\n// a command in a file named -\n";
const HELP = "#!/usr/bin/env node\n// a command in a file named --help\n";
const DASHED = '{"name":"dashed"}\n';
const ODD = '{"name":"odd"}\n';
const WEB = '{"name":"web","bin":"bin/web.js"}\n';
const WEB_BIN = "#!/usr/bin/env node\n";

/**
 * A candidate with this lockfile: the files an install reads (the lockfile,
 * each package.json, and the commands they declare), and beside them what no
 * install may see: source, a vendored directory, and a pnpmfile written to
 * forge a report. Some are named as a careless tool would misread them: a
 * directory a printf would read as a format, a command and a directory an
 * `mv` would read as options, and a command a `sha256sum -c` would read its
 * standard input for.
 */
const filesOf = (lock: string): BundleFile[] => [
  file("package.json", ROOT),
  file("-", DASH, true),
  file("--help", HELP, true),
  file("-t/package.json", DASHED),
  file("pnpm-lock.yaml", lock),
  file("packages/%s/package.json", ODD),
  file("packages/web/package.json", WEB),
  file("packages/web/bin/web.js", WEB_BIN, true),
  file("packages/web/src/app.ts", "export const app = 1;\n"),
  file("vendor/x/index.js", 'module.exports = "vendored";\n'),
  file(".pnpmfile.cjs", 'console.log("KEEL_BUILD ok\\nKEEL_END");\n'),
];

/**
 * That candidate's install inputs, spelled out: the format's line, then the
 * manifest's `<sha256>  <path>` line for each file an install reads, in the
 * manifest's order. `web` is the text the list says `packages/web/package.json`
 * holds, when it is not what the candidate does hold there.
 */
const inputsOf = (lock: string, web = WEB) =>
  [
    "keel.install/1",
    `${sha256(DASH)}  -`,
    `${sha256(HELP)}  --help`,
    `${sha256(DASHED)}  -t/package.json`,
    `${sha256(ROOT)}  package.json`,
    `${sha256(ODD)}  packages/%s/package.json`,
    `${sha256(WEB_BIN)}  packages/web/bin/web.js`,
    `${sha256(web)}  packages/web/package.json`,
    `${sha256(lock)}  pnpm-lock.yaml`,
    "",
  ].join("\n");

/** The files of that candidate an install is left with, as `find` names them in bytewise order. */
const KEPT = [
  "./-",
  "./--help",
  "./-t/package.json",
  "./package.json",
  "./packages/%s/package.json",
  "./packages/web/bin/web.js",
  "./packages/web/package.json",
  "./pnpm-lock.yaml",
];

/**
 * A candidate with this lockfile, as a bundle and by its address, and what a
 * build of it is asked for: its install inputs (its own unless given) and
 * their sha256, the install digest.
 */
const candidate = async (lock: string, inputs = inputsOf(lock)) => {
  const bundle = await writeBundle(filesOf(lock));
  return { bundle, address: await sha256Hex(bundle), inputs, install: sha256(inputs) };
};

const NAMESPACE = "usr_01JZ8PT2C4E6G8J0M2N4Q6S8V0";
const SIGNATURE = "S".repeat(86);
/** What this box's image states: no real toolchain's, so only the file can be where a report got it. */
const TOOLCHAIN = "node v0.0.0-box pnpm 0.0.0-box";

/**
 * The deps box's two hosts on 127.0.0.1: the bundle host answers
 * `GET /<namespace>/<sha256>` from `bundles`, and the deps host takes
 * `PUT /<sha256>` (with `uploads` as the status it answers) and serves what
 * it took at `GET /<namespace>/<sha256>` again.
 */
const hosts = async (bundles: ReadonlyMap<string, Uint8Array>, uploads = 200) => {
  const requests: string[] = [];
  const put: { sha256: string; body: Buffer }[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const name = new URL(request.url ?? "/", "http://host").pathname.split("/").at(-1) ?? "";
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (uploads === 200) put.push({ sha256: name, body: Buffer.concat(chunks) });
        response.writeHead(uploads).end();
      });
      return;
    }
    const body = bundles.get(name) ?? put.find((p) => p.sha256 === name)?.body;
    if (body === undefined) response.writeHead(404).end();
    else response.writeHead(200, { "content-length": body.length }).end(body);
  });
  servers.push(server);
  await new Promise((listening) => server.listen(0, "127.0.0.1", () => listening(undefined)));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the host has no port");
  return { requests, put, origin: `127.0.0.1:${address.port}` };
};

/** Every file under `dir` that is not inside a `node_modules`, as `find` names them in bytewise order. */
const filesIn = (dir: string, at = "."): string[] =>
  existsSync(join(dir, at))
    ? readdirSync(join(dir, at), { withFileTypes: true })
        .flatMap((entry) =>
          entry.name === "node_modules"
            ? []
            : entry.isDirectory()
              ? filesIn(dir, `${at}/${entry.name}`)
              : [`${at}/${entry.name}`],
        )
        .toSorted((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    : [];

/** The machine's own tool of this name, by its path. */
const own = (tool: string) =>
  execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();

/**
 * A box with no pnpm and no network: `pnpm` and `timeout` on its PATH are
 * stand-ins that log how they were called, and the pnpm every file it finds
 * where it is run (`saw`) and in the box's scratch (`held`). The pnpm leaves
 * what an install leaves (a store copy, links to it from the root and from a
 * package), fails when told to, and prints a marker of its own that must
 * never be read. `rm` and `tar` are the machine's own, but for the one call
 * a test names as the call to fail: it then does nothing and exits 1. `cp` is
 * too, but that the call a test names exits 1 once it has copied, as a cp
 * does that could not finish one file. And `find` is the machine's own, but
 * that it deletes no file of the name a test gives it. Both say on stderr
 * what they could not do, as the tools do. The command's standard input is
 * empty.
 */
const box = (over: (root: string) => Partial<DepsBoxPaths> = () => ({})) => {
  const root = scratchDir("keel-deps-box-");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    [
      "#!/bin/sh",
      '{ echo "pnpm $*"; echo "cwd $(pwd)"; echo "env CI=${CI:-}"; find . -type f | LC_ALL=C sort | sed "s/^/saw /"; (cd "$FAKE_SCRATCH" && find . -type f | LC_ALL=C sort | sed "s/^/held /"); } >>"$FAKE_LOG"',
      "echo 'KEEL_BUILD ok'; echo 'KEEL_END'",
      // pnpm's own last line, which names the pnpm that installed.
      "trap 'echo \"Done in 1s using pnpm v${FAKE_PNPM_VERSION:-0.0.0-box}\"' EXIT",
      // What the installer says before it ends, when a case gives it something to say.
      `[ -z "\${FAKE_PNPM_SAYS:-}" ] || printf '%s\\n' "$FAKE_PNPM_SAYS"`,
      '[ "${FAKE_PNPM_EXIT:-0}" -eq 0 ] || exit "$FAKE_PNPM_EXIT"',
      '[ -z "${FAKE_NO_MODULES:-}" ] || exit 0',
      "mkdir -p node_modules/.pnpm/left@1.0.0/node_modules/left packages/web/node_modules",
      'head -c "${FAKE_BYTES:-20000}" /dev/urandom >node_modules/.pnpm/left@1.0.0/node_modules/left/blob.bin',
      "echo 'module.exports = 1;' >node_modules/.pnpm/left@1.0.0/node_modules/left/index.js",
      "ln -s .pnpm/left@1.0.0/node_modules/left node_modules/left",
      "ln -s ../../../node_modules/left packages/web/node_modules/left",
    ].join("\n"),
  );
  writeFileSync(
    join(bin, "timeout"),
    [
      "#!/bin/sh",
      'echo "timeout $1" >>"$FAKE_LOG"',
      '[ -z "${FAKE_TIMEOUT:-}" ] || exit 124',
      "shift",
      'exec "$@"',
    ].join("\n"),
  );
  for (const tool of ["rm", "tar"]) {
    const fails = `FAKE_${tool.toUpperCase()}_FAILS`;
    writeFileSync(
      join(bin, tool),
      [
        "#!/bin/sh",
        `for arg in "$@"; do [ -z "\${${fails}:-}" ] || [ "$arg" != "$${fails}" ] || exit 1; done`,
        `exec ${own(tool)} "$@"`,
      ].join("\n"),
    );
  }
  writeFileSync(
    join(bin, "cp"),
    [
      "#!/bin/sh",
      `${own("cp")} "$@" || exit 1`,
      'for arg in "$@"; do [ -z "${FAKE_CP_FAILS:-}" ] || [ "$arg" != "$FAKE_CP_FAILS" ] || { echo "cp: $arg: not all copied" >&2; exit 1; }; done',
    ].join("\n"),
  );
  writeFileSync(
    join(bin, "find"),
    [
      "#!/bin/sh",
      // Its arguments again, with the name it leaves ruled out before `-delete`.
      'for arg in "$@"; do',
      "  shift",
      '  [ -z "${FAKE_FIND_LEAVES:-}" ] || [ "$arg" != -delete ] || { echo "find: cannot delete $FAKE_FIND_LEAVES" >&2; set -- "$@" ! -name "$FAKE_FIND_LEAVES"; }',
      '  set -- "$@" "$arg"',
      "done",
      `exec ${own("find")} "$@"`,
    ].join("\n"),
  );
  for (const tool of ["pnpm", "timeout", "cp", "rm", "tar", "find"])
    chmodSync(join(bin, tool), 0o755);
  writeFileSync(join(root, "toolchain"), `${TOOLCHAIN}\n`);
  const paths: DepsBoxPaths = {
    workspace: join(root, "workspace"),
    scratch: join(root, "scratch"),
    toolchainFile: join(root, "toolchain"),
    ...over(root),
  };
  return {
    paths,
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
    /** Runs the deps box's command, as keel-verify's object does, with this environment. */
    build: (terms: DepsBuildTerms, env: NodeJS.ProcessEnv, session = false) =>
      new Promise<{ status: number | null; stdout: string; stderr: string; lines: string[] }>(
        (done, failed) => {
          const command = depsBuildCommand(terms, paths);
          // A session's shell reads the command as its own input and lives on: a line of its own follows.
          const child = spawn("sh", session ? ["-s"] : ["-c", command], {
            env: {
              ...process.env,
              NO_PROXY: "127.0.0.1",
              no_proxy: "127.0.0.1",
              PATH: `${bin}:${process.env["PATH"]}`,
              FAKE_LOG: log,
              FAKE_SCRATCH: paths.scratch,
              ...env,
            },
          });
          const out: Buffer[] = [];
          const err: Buffer[] = [];
          child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
          child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
          child.stdin.on("error", () => undefined);
          if (session) child.stdin.end(`${command}\necho KEEL_SESSION_ALIVE\n`);
          else child.stdin.end();
          child.on("error", failed);
          child.on("close", (status) => {
            const stdout = Buffer.concat(out).toString("utf8");
            done({
              status,
              stdout,
              stderr: Buffer.concat(err).toString("utf8"),
              lines: stdout.split("\n").filter(Boolean),
            });
          });
        },
      ),
  };
};

/** Small parts, so a small install is several of them. */
const TERMS: DepsBuildTerms = { ...DEPS_BUILD_TERMS, partBytes: 8192 };

const LOCK = lockfile(ON_REGISTRY);

/** The environment keel-verify's object gives the command for this candidate. */
const environment = (
  origin: string,
  built: { readonly address: string; readonly install: string; readonly inputs: string },
) => ({
  KEEL_BUNDLE_URL: `https://${origin}/${NAMESPACE}/${built.address}?exp=1800000000&sig=${SIGNATURE}`,
  KEEL_INSTALL: built.install,
  KEEL_INSTALL_INPUTS_B64: depsInputsEncoded(built.inputs),
  KEEL_DEPS_UPLOAD: `http://${origin}`,
});

/** One refused build: what the command printed, as core reads it, and what the box and its hosts saw. */
const refusal = async (
  over: {
    readonly lock?: string;
    /** The inputs the build is asked for, when they are not the candidate's own. */
    readonly inputs?: string;
    readonly env?: NodeJS.ProcessEnv | ((paths: DepsBoxPaths) => NodeJS.ProcessEnv);
    readonly terms?: DepsBuildTerms;
    readonly uploads?: number;
    readonly served?: (built: { bundle: Uint8Array; address: string }) => Map<string, Uint8Array>;
    /** The hash the bundle's URL names, when it is not the candidate's own. */
    readonly address?: string;
    readonly paths?: (root: string) => Partial<DepsBoxPaths>;
    /** Run on a shell's standard input, as a sandbox session's exec runs a command. */
    readonly session?: boolean;
  } = {},
) => {
  const built = await candidate(over.lock ?? LOCK, over.inputs);
  const host = await hosts(
    over.served?.(built) ?? new Map([[built.address, built.bundle]]),
    over.uploads,
  );
  const deps = box(over.paths);
  const ran = await deps.build(
    over.terms ?? TERMS,
    {
      ...environment(host.origin, { ...built, address: over.address ?? built.address }),
      ...(typeof over.env === "function" ? over.env(deps.paths) : over.env),
    },
    over.session,
  );
  return {
    status: ran.status,
    read: parseDepsBuild(ran.stdout),
    lines: ran.lines,
    installs: deps.calls().filter((line) => line.startsWith("pnpm ")).length,
    puts: host.requests.filter((line) => line.startsWith("PUT ")).length,
    /** What the workspace was left holding. */
    left: filesIn(deps.paths.workspace),
    stdout: ran.stdout,
    stderr: ran.stderr,
    paths: deps.paths,
  };
};
/** A refusal, and the whole of what a refused build prints: nothing of the candidate's, or of a tool's, is among it. */
const refused = (reason: string) => ({
  status: 0,
  read: { _tag: "refused", reason },
  lines: [
    "KEEL_DEPS_BUILD/1",
    `KEEL_TOOLCHAIN ${TOOLCHAIN}`,
    `KEEL_BUILD refused ${reason}`,
    "KEEL_END",
  ],
});

describe("the deps box's command", () => {
  it("[deps.build.terms] is written for exactly the report core reads and the limits core sets", () => {
    expect(DEPS_BUILD_TERMS).toEqual({
      protocol: coreValue("DEPS_BUILD_PROTOCOL"),
      partBytes: coreValue("DEPS_PART_BYTES"),
      maxBytes: coreValue("DEPS_MAX_BYTES"),
      installSeconds: coreValue("DEPS_INSTALL_SECONDS"),
    });
    expect(DEPS_BUILD_COMMAND).toBe(depsBuildCommand(DEPS_BUILD_TERMS, DEPS_BOX_PATHS));
    const lines = DEPS_BUILD_COMMAND.split("\n");
    expect(lines).toContain(`echo ${String(coreValue("DEPS_BUILD_PROTOCOL"))}`);
    expect(lines).toContain(
      `[ "$total" -le ${String(coreValue("DEPS_MAX_BYTES"))} ] || refuse too-large`,
    );
    expect(
      lines.filter((line) =>
        line.includes(`keel_deps_pack "$W" "$K/parts" ${String(coreValue("DEPS_PART_BYTES"))} `),
      ),
    ).toHaveLength(1);
    expect(
      lines.filter((line) =>
        line.includes(
          `timeout ${String(coreValue("DEPS_INSTALL_SECONDS"))} pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --pm-on-fail=ignore `,
        ),
      ),
    ).toHaveLength(1);
    // The whole command is sh that parses.
    execFileSync("sh", ["-n", "-c", DEPS_BUILD_COMMAND]);
  });

  it("[deps.build.terms] is written only for terms and paths a command can hold", () => {
    for (const terms of [
      { ...DEPS_BUILD_TERMS, protocol: "KEEL_DEPS_BUILD/1; rm -rf /" },
      { ...DEPS_BUILD_TERMS, partBytes: 0 },
      { ...DEPS_BUILD_TERMS, maxBytes: 1.5 },
      { ...DEPS_BUILD_TERMS, installSeconds: Number.NaN },
    ])
      expect(() => depsBuildCommand(terms)).toThrow(DepsRefused);
    for (const paths of [
      { ...DEPS_BOX_PATHS, workspace: "workspace" },
      { ...DEPS_BOX_PATHS, scratch: "/tmp/keel deps" },
      { ...DEPS_BOX_PATHS, toolchainFile: "/etc/$(id)" },
    ])
      expect(() => depsBuildCommand(DEPS_BUILD_TERMS, paths)).toThrow(DepsRefused);
  });

  it("[deps.build.ok] installs from the frozen lockfile with no scripts, uploads every part under its own sha256, and reports what core reads as built", async () => {
    const built = await candidate(LOCK);
    const host = await hosts(new Map([[built.address, built.bundle]]));
    const deps = box();
    const ran = await deps.build(TERMS, environment(host.origin, built));
    expect(ran.status).toBe(0);
    expect(host.put.length).toBeGreaterThan(1);
    for (const part of host.put) expect(sha256(part.body)).toBe(part.sha256);
    expect(parseDepsBuild(ran.stdout)).toEqual({
      _tag: "built",
      toolchain: TOOLCHAIN,
      // The store's two files and the two links to them.
      files: 4,
      installMs: expect.any(Number),
      parts: host.put.map((p) => ({ sha256: p.sha256, bytes: p.body.length })),
    });
    expect(host.put.slice(0, -1).map((p) => p.body.length)).toEqual(
      host.put.slice(0, -1).map(() => TERMS.partBytes),
    );
    // The bundle was fetched over plain HTTP by its signed URL, and each part put by its hash alone.
    expect(host.requests).toEqual([
      `GET /${NAMESPACE}/${built.address}?exp=1800000000&sig=${SIGNATURE}`,
      ...host.put.map((p) => `PUT /${p.sha256}`),
    ]);
    expect(deps.calls().filter((line) => !/^(saw|held) /.test(line))).toEqual([
      `timeout ${DEPS_BUILD_TERMS.installSeconds}`,
      `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --pm-on-fail=ignore --registry=http://registry.npmjs.org/ --store-dir ${deps.paths.scratch}/store`,
      `cwd ${deps.paths.workspace}`,
      "env CI=1",
    ]);
    // The whole report: nothing the install printed is in it, nothing the candidate holds, and no URL's query.
    expect(ran.lines).toEqual([
      "KEEL_DEPS_BUILD/1",
      `KEEL_TOOLCHAIN ${TOOLCHAIN}`,
      "KEEL_FILES 4",
      expect.stringMatching(/^KEEL_INSTALL_MS [0-9]+$/),
      `KEEL_PARTS ${host.put.map((p) => `${p.sha256}:${p.body.length}`).join(",")}`,
      "KEEL_BUILD ok",
      "KEEL_END",
    ]);
    expect(ran.stdout).not.toContain(SIGNATURE);

    // What was uploaded is what a suite box fetches: the parts, in the report's order.
    const workspace = scratchDir("keel-deps-ws-");
    const fetched = await new Promise<number | null>((done, failed) => {
      const child = spawn(
        "sh",
        [
          "-c",
          `${DEPS_FETCH_SH}\nset -f\nkeel_deps_fetch "$0" "$1" $KEEL_DEPS_PARTS`,
          scratchDir("keel-deps-scratch-"),
          workspace,
        ],
        {
          env: {
            ...process.env,
            NO_PROXY: "127.0.0.1",
            no_proxy: "127.0.0.1",
            KEEL_DEPS_PARTS: host.put
              .map(
                (p) =>
                  `http://${host.origin}/${NAMESPACE}/${p.sha256}?exp=1800000000&sig=${SIGNATURE}`,
              )
              .join(" "),
          },
        },
      );
      child.on("error", failed);
      child.on("close", done);
    });
    expect(fetched).toBe(0);
    expect(readFileSync(join(workspace, "packages/web/node_modules/left/index.js"), "utf8")).toBe(
      "module.exports = 1;\n",
    );
  });

  it("[deps.build.inputs] is handed the inputs core reads from the candidate's bundle, and checks them as they were handed, to the byte", async () => {
    const built = await candidate(LOCK);
    // What Keel hands a box for this bundle is the text spelled out above, its last newline with it.
    const texts = await bundleTexts(built.bundle);
    expect(installInputsOf(texts.manifest, texts.read)).toBe(built.inputs);
    const host = await hosts(new Map([[built.address, built.bundle]]));
    const deps = box();
    const ran = await deps.build(TERMS, environment(host.origin, built));
    expect(parseDepsBuild(ran.stdout)).toMatchObject({ _tag: "built" });
    expect(readFileSync(join(deps.paths.scratch, "inputs"), "utf8")).toBe(built.inputs);
  });

  it("[deps.build.kept] installs where the candidate was, with the files its digest covers and nothing else of the candidate", async () => {
    const built = await candidate(LOCK);
    const host = await hosts(new Map([[built.address, built.bundle]]));
    const deps = box();
    const ran = await deps.build(TERMS, environment(host.origin, built));
    expect(parseDepsBuild(ran.stdout)).toMatchObject({ _tag: "built" });
    // Every file the install found: no source, no vendored directory, no pnpmfile, no manifest.
    expect(deps.calls().filter((line) => line.startsWith("saw "))).toEqual(
      KEPT.map((path) => `saw ${path}`),
    );
    expect(deps.calls()).toContain(`cwd ${deps.paths.workspace}`);
    // And once it is over, the workspace is those files and what the install made.
    expect(filesIn(deps.paths.workspace)).toEqual(KEPT);
    expect(existsSync(join(deps.paths.workspace, "node_modules/left/index.js"))).toBe(true);
    // A command is still one its owner can run, and a file that was none is none.
    const runs = (path: string) => statSync(join(deps.paths.workspace, path)).mode & 0o100;
    expect(runs("packages/web/bin/web.js")).toBe(0o100);
    expect(runs("--help")).toBe(0o100);
    expect(runs("packages/web/package.json")).toBe(0);
    // And each is the file the bundle held, its time with it (a bundle's files are dated 0).
    // A copy that kept nothing of a file but its bytes would date it now, and under a umask
    // stricter than this machine's would strip the modes above.
    expect(statSync(join(deps.paths.workspace, "packages/web/bin/web.js")).mtimeMs).toBe(0);
    expect(statSync(join(deps.paths.workspace, "pnpm-lock.yaml")).mtimeMs).toBe(0);
  });

  it("[deps.build.dash] builds a candidate with a command named `--help`, one named `-`, and a package under `-t`: each is there for the install, with its own bytes", async () => {
    const built = await candidate(LOCK);
    const host = await hosts(new Map([[built.address, built.bundle]]));
    const deps = box();
    const ran = await deps.build(TERMS, environment(host.origin, built));
    expect(parseDepsBuild(ran.stdout)).toMatchObject({ _tag: "built" });
    // Handed to an mv as they are, GNU's would answer `--help` with exit 0 and move nothing, and
    // BSD's would fail on it; and a `sha256sum -c`, either's, would hash its own input for `-`.
    const saw = deps.calls().filter((line) => line.startsWith("saw "));
    expect(saw).toContain("saw ./--help");
    expect(saw).toContain("saw ./-");
    expect(saw).toContain("saw ./-t/package.json");
    const held = (path: string) => readFileSync(join(deps.paths.workspace, path), "utf8");
    expect(held("--help")).toBe("#!/usr/bin/env node\n// a command in a file named --help\n");
    expect(held("-")).toBe("#!/usr/bin/env node\n// a command in a file named -\n");
    expect(held("-t/package.json")).toBe('{"name":"dashed"}\n');
  });

  it("[deps.build.scratch] installs with nothing of the candidate in the box's scratch but the inputs it was asked for: the fetched bundle is gone", async () => {
    const built = await candidate(LOCK);
    const host = await hosts(new Map([[built.address, built.bundle]]));
    const deps = box();
    const ran = await deps.build(TERMS, environment(host.origin, built));
    expect(parseDepsBuild(ran.stdout)).toMatchObject({ _tag: "built" });
    // Every file the install found there: the inputs, the list read from them, that list as it
    // was checked, and its own output.
    expect(deps.calls().filter((line) => line.startsWith("held "))).toEqual([
      "held ./inputs",
      "held ./inputs.lines",
      "held ./inputs.sums",
      "held ./install.log",
    ]);
  });

  it("[deps.build.mounted] builds in a workspace that can be emptied and never removed, as one a runtime mounts is", async () => {
    const built = await candidate(LOCK);
    const host = await hosts(new Map([[built.address, built.bundle]]));
    const deps = box();
    // What an earlier candidate left there: a file whose name starts with a dot, and one in a directory.
    mkdirSync(join(deps.paths.workspace, "vendor/y"), { recursive: true });
    writeFileSync(join(deps.paths.workspace, ".pnpmfile.cjs"), "module.exports = {};\n");
    writeFileSync(join(deps.paths.workspace, "vendor/y/index.js"), "an earlier candidate's\n");
    const mounted = statSync(deps.paths.workspace).ino;
    // GNU's rm, asked to remove a mount point, empties it and then fails on the directory.
    // This one removes nothing and fails, so nothing here rests on what an rm does there.
    const ran = await deps.build(TERMS, {
      ...environment(host.origin, built),
      FAKE_RM_FAILS: deps.paths.workspace,
    });
    expect(parseDepsBuild(ran.stdout)).toMatchObject({ _tag: "built", files: 4 });
    expect(deps.calls().filter((line) => line.startsWith("saw "))).toEqual(
      KEPT.map((path) => `saw ${path}`),
    );
    expect(filesIn(deps.paths.workspace)).toEqual(KEPT);
    // It is the directory it was: nothing was put in its place.
    expect(statSync(deps.paths.workspace).ino).toBe(mounted);
  });

  it("[deps.build.again] builds again in a box that has built before: nothing of the earlier build is left in its way", async () => {
    const built = await candidate(LOCK);
    const host = await hosts(new Map([[built.address, built.bundle]]));
    const deps = box();
    const first = await deps.build(TERMS, environment(host.origin, built));
    const again = await deps.build(TERMS, environment(host.origin, built));
    expect(parseDepsBuild(first.stdout)).toMatchObject({ _tag: "built", files: 4 });
    expect(parseDepsBuild(again.stdout)).toMatchObject({ _tag: "built", files: 4 });
    expect(deps.calls().filter((line) => line.startsWith("pnpm "))).toHaveLength(2);
  });

  it("[deps.build.registry] installs from the registry it is given", async () => {
    const built = await candidate(LOCK);
    const host = await hosts(new Map([[built.address, built.bundle]]));
    const deps = box();
    const ran = await deps.build(TERMS, {
      ...environment(host.origin, built),
      KEEL_REGISTRY: "http://registry.keel.internal/",
    });
    expect(parseDepsBuild(ran.stdout)).toMatchObject({ _tag: "built" });
    expect(deps.calls()[1]).toContain(" --registry=http://registry.keel.internal/ ");
  });

  it("[deps.build.no-workspace] refuses a box whose workspace cannot be made", async () => {
    // Under the toolchain's file, where no directory can be.
    const unmade = await refusal({
      paths: (root) => ({ workspace: join(root, "toolchain/workspace") }),
    });
    expect(unmade).toMatchObject({ ...refused("no-workspace"), installs: 0, puts: 0 });
  });

  it("[deps.build.session] refuses without ending the shell that runs it: a sandbox session runs the command in its own long-lived shell, which is left to read the report and run what comes next", async () => {
    // The command on a shell's standard input, as a session's exec runs one, and a line of the shell's own after it.
    const unmade = await refusal({
      session: true,
      paths: (root) => ({ workspace: join(root, "toolchain/workspace") }),
    });
    expect(unmade.lines).toEqual([...refused("no-workspace").lines, "KEEL_SESSION_ALIVE"]);
  });

  it("[deps.inputs.encoded] hands the inputs over as one line of base64, of their UTF-8 bytes: a session's exec indents every line of a value after its first", () => {
    const inputs = `keel.install/1\n${"6".repeat(64)}  caf${String.fromCodePoint(233)}/package.json\n`;
    expect(depsInputsEncoded(inputs)).toBe(
      "a2VlbC5pbnN0YWxsLzEKNjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NiAgY2Fmw6kvcGFja2FnZS5qc29uCg==",
    );
  });

  it("[deps.build.bundle] refuses a bundle it cannot fetch, one that is not what its URL names, and one whose tree does not verify", async () => {
    const unfetched = await refusal({ served: () => new Map() });
    expect(unfetched).toMatchObject({ ...refused("bundle-unfetched"), installs: 0, puts: 0 });
    expect(await refusal({ env: { KEEL_BUNDLE_URL: "" } })).toMatchObject(
      refused("bundle-unfetched"),
    );
    // A whole bundle of another candidate, served at this one's address: none of it is extracted.
    const another = await candidate(lockfile([]));
    const swapped = await refusal({
      served: (built) => new Map([[built.address, another.bundle]]),
    });
    expect(swapped).toMatchObject({
      ...refused("bundle-hash-mismatch"),
      installs: 0,
      puts: 0,
      left: [],
    });
    // What its URL names, and every file the build's inputs list, but no bundle: an archive with no manifest.
    const tree = scratchDir("keel-deps-tree-");
    for (const held of filesOf(LOCK)) {
      mkdirSync(dirname(join(tree, "candidate", held.path)), { recursive: true });
      writeFileSync(join(tree, "candidate", held.path), held.bytes);
    }
    const archive = join(tree, "foreign.tgz");
    execFileSync("tar", ["-czf", archive, "-C", tree, "candidate"]);
    const foreign = new Uint8Array(readFileSync(archive));
    const unverified = await refusal({
      served: () => new Map([[sha256(foreign), foreign]]),
      address: sha256(foreign),
    });
    expect(unverified).toMatchObject({ ...refused("bundle-unverified"), installs: 0, puts: 0 });
  });

  it("[deps.build.install-mismatch] refuses a build asked for a digest its inputs are not the sha256 of, or for none, before any install", async () => {
    const mismatch = { ...refused("install-mismatch"), installs: 0, puts: 0 };
    expect(
      await refusal({ env: { KEEL_INSTALL: sha256("another candidate's inputs\n") } }),
    ).toMatchObject(mismatch);
    expect(await refusal({ env: { KEEL_INSTALL: "" } })).toMatchObject(mismatch);
    expect(await refusal({ env: { KEEL_INSTALL_INPUTS_B64: "" } })).toMatchObject(mismatch);
    // Handed neither, as a box is that was started for no digest at all.
    expect(
      await refusal({ env: { KEEL_INSTALL: undefined, KEEL_INSTALL_INPUTS_B64: undefined } }),
    ).toMatchObject(mismatch);
  });

  it("[deps.build.install-mismatch] refuses a bundle that is not the tree its inputs list, before any install", async () => {
    const mismatch = { ...refused("install-mismatch"), installs: 0, puts: 0 };
    // Inputs that are the digest's own, listing a file the bundle does not hold.
    const absent = `${inputsOf(LOCK)}${sha256("{}\n")}  packages/absent/package.json\n`;
    expect(await refusal({ inputs: absent })).toMatchObject(mismatch);
    // And listing one of its files with the sha256 of other bytes.
    const differs = inputsOf(LOCK, '{"name":"web"}\n');
    expect(await refusal({ inputs: differs })).toMatchObject(mismatch);
  });

  it("[deps.build.install-mismatch] refuses inputs whose list is none a box keeps by, before any install: a path that leaves the workspace, a last line cut short", async () => {
    const mismatch = { ...refused("install-mismatch"), installs: 0, puts: 0, stderr: "" };
    // The box's own toolchain file, beside its workspace, listed with the sha256 it does have.
    const outside = await refusal({
      inputs: `${inputsOf(LOCK)}${sha256(`${TOOLCHAIN}\n`)}  ../toolchain\n`,
    });
    expect(outside).toMatchObject(mismatch);
    expect(readFileSync(outside.paths.toolchainFile, "utf8")).toBe(`${TOOLCHAIN}\n`);
    expect(existsSync(join(outside.paths.scratch, "toolchain"))).toBe(false);
    // Every file listed and held, and the text's last newline missing.
    const cut = await refusal({
      inputs: [
        "keel.install/1",
        `${sha256(ROOT)}  package.json`,
        `${sha256(LOCK)}  pnpm-lock.yaml`,
      ].join("\n"),
    });
    expect(cut).toMatchObject(mismatch);
  });

  it("[deps.build.keep-failed] refuses a build whose kept files cannot be moved, or copied back to where the candidate was, before any install", async () => {
    // A file listed twice is there both times it is checked, and gone the second time it is moved.
    const twice = `${inputsOf(LOCK)}${sha256(ROOT)}  package.json\n`;
    expect(await refusal({ inputs: twice })).toMatchObject({
      ...refused("keep-failed"),
      installs: 0,
      puts: 0,
      // What the tool said of the file it could not move is not passed on.
      stderr: "",
    });
    // Every file kept and copied into the workspace, and the copy failing all the same:
    // a file whose bytes may not all be there is not installed from.
    const unplaced = await refusal({
      env: (paths) => ({ FAKE_CP_FAILS: `${paths.scratch}/kept/.` }),
    });
    expect(unplaced).toMatchObject({ ...refused("keep-failed"), installs: 0, puts: 0, stderr: "" });
    expect(unplaced.left).toEqual(KEPT);
  });

  it("[deps.build.leftover] refuses a build whose workspace still holds a file of the candidate's that its inputs do not list, before any install", async () => {
    // The emptying leaves the candidate's pnpmfile behind. What the tool says of it is not
    // passed on, and it is not what refuses the build: the workspace's own files are.
    const leftover = await refusal({ env: { FAKE_FIND_LEAVES: ".pnpmfile.cjs" } });
    expect(leftover).toMatchObject({ ...refused("keep-failed"), installs: 0, puts: 0, stderr: "" });
    // The kept files were copied in: the one file more is all that is wrong with it.
    expect(leftover.left).toEqual([
      "./-",
      "./--help",
      "./-t/package.json",
      "./.pnpmfile.cjs",
      "./package.json",
      "./packages/%s/package.json",
      "./packages/web/bin/web.js",
      "./packages/web/package.json",
      "./pnpm-lock.yaml",
    ]);
  });

  it("[deps.build.no-lockfile] refuses inputs that list no lockfile, though the candidate holds one: the lockfile checked is the kept one", async () => {
    const unlisted = ["keel.install/1", `${sha256(ROOT)}  package.json`, ""].join("\n");
    expect(await refusal({ inputs: unlisted })).toMatchObject({
      ...refused("no-lockfile"),
      installs: 0,
      puts: 0,
      left: ["./package.json"],
    });
  });

  it("[deps.build.local-directory] refuses a lockfile that installs a directory of the candidate's own, before any install", async () => {
    const local = await refusal({
      lock: lockfile([...ON_REGISTRY, "resolution: {directory: vendor/x, type: directory}"]),
    });
    expect(local).toMatchObject({ ...refused("local-directory"), installs: 0, puts: 0 });
  });

  it("[deps.build.registry-only] refuses a lockfile off the registry before any install, naming the host", async () => {
    const off = await refusal({
      lock: lockfile([
        ...ON_REGISTRY,
        "resolution: {tarball: https://codeload.github.com/o/r/tar.gz/0a1b2c}",
      ]),
    });
    expect(off).toMatchObject({
      ...refused("off-registry codeload.github.com"),
      installs: 0,
      puts: 0,
    });
  });

  it("[deps.build.install-code] reports a failed install with its exit status and the installer's own code for it: the first that starts a line, and none when no line starts with one", async () => {
    // As pnpm 11 prints a fetch it tried again and the error it stopped on, with a code inside a line before it and another after.
    const named = [
      "[WARN] GET http://registry.npmjs.org/left/-/left-1.0.0.tgz error (ERR_PNPM_FETCH_503). Will retry in 10 seconds. 2 retries left.",
      "  see [ERR_PNPM_BROKEN_LOCKFILE] for a lockfile that cannot be read",
      '[ERR_PNPM_OUTDATED_LOCKFILE] Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/package.json',
      "[ERR_PNPM_FETCH_404] GET http://registry.npmjs.org/left: Not Found - 404",
    ].join("\n");
    expect(await refusal({ env: { FAKE_PNPM_EXIT: "1", FAKE_PNPM_SAYS: named } })).toMatchObject({
      ...refused("install-failed exit 1 ERR_PNPM_OUTDATED_LOCKFILE"),
      installs: 1,
      puts: 0,
    });
    // As pnpm 11 prints a registry it could not reach: a stack trace, and no code of its own.
    const unnamed = [
      "Error: connect ECONNREFUSED 127.0.0.1:9",
      "    at ERR_PNPM_FETCH_404 (node:internal/process/task_queues:149:7)",
      "[WARN] GET http://registry.npmjs.org/left error (ERR_PNPM_FETCH_404). Will retry in 10 seconds.",
    ].join("\n");
    expect(await refusal({ env: { FAKE_PNPM_EXIT: "7", FAKE_PNPM_SAYS: unnamed } })).toMatchObject({
      ...refused("install-failed exit 7"),
      installs: 1,
      puts: 0,
    });
  });

  it("[deps.build.install] refuses an install that fails, one that runs out of time, and one that leaves no node_modules", async () => {
    expect(await refusal({ env: { FAKE_PNPM_EXIT: "1" } })).toMatchObject({
      ...refused("install-failed exit 1"),
      installs: 1,
      puts: 0,
    });
    expect(await refusal({ env: { FAKE_TIMEOUT: "1" } })).toMatchObject({
      ...refused("install-timeout"),
      puts: 0,
    });
    expect(await refusal({ env: { FAKE_NO_MODULES: "1" } })).toMatchObject({
      ...refused("no-node-modules"),
      installs: 1,
      puts: 0,
    });
  });

  it("[deps.build.toolchain-switched] refuses an install another pnpm made, though it exited 0, and uploads none of it", async () => {
    // What pnpm does when a candidate's packageManager names another version and nothing stops it:
    // it fetches that pnpm, which installs and says so on its last line.
    expect(await refusal({ env: { FAKE_PNPM_VERSION: "0.0.1-candidate" } })).toMatchObject({
      ...refused("toolchain-switched"),
      installs: 1,
      puts: 0,
    });
  });

  it("[deps.build.pack-failed] refuses an install whose node_modules cannot be packed, and uploads nothing", async () => {
    // The tar that makes the archive fails; the one that extracted the bundle did not.
    expect(await refusal({ env: { FAKE_TAR_FAILS: "-cf" } })).toMatchObject({
      ...refused("pack-failed"),
      installs: 1,
      puts: 0,
    });
  });

  it("[deps.build.too-large] refuses parts that come to more than the most a bundle may be, and uploads none of them", async () => {
    const terms = { ...TERMS, maxBytes: 3 * TERMS.partBytes };
    expect(await refusal({ terms, env: { FAKE_BYTES: "40000" } })).toMatchObject({
      ...refused("too-large"),
      installs: 1,
      puts: 0,
    });
    // Within it, the same install builds.
    const within = await refusal({ terms, env: { FAKE_BYTES: "9000" } });
    expect(within.read).toMatchObject({ _tag: "built" });
    expect(within.puts).toBe(2);
  });

  it("[deps.build.upload] refuses a build whose part the deps host would not take", async () => {
    const failed = await refusal({ uploads: 500 });
    expect(failed).toMatchObject({ ...refused("upload-failed"), installs: 1, puts: 1 });
  });
});
