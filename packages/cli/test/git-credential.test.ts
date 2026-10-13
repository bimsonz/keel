import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Exec } from "../src/key-store.ts";
import { type Io, run } from "../src/run.ts";
import { keel, ORIGIN, TOKEN } from "./person.ts";

/** What git writes to a helper on stdin: the address it wants a credential for. */
const asked = (protocol: string, host: string, more = "") =>
  `protocol=${protocol}\nhost=${host}\n${more}\n`;

/** git's helper, run as git runs it: no `KEEL_URL`, the address on stdin. */
async function helper(
  io: Io,
  stdin: string,
  argv: readonly string[] = ["get"],
  env: Record<string, string> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  let read = 0;
  const code = await run(["auth", "git-credential", ...argv], {
    ...io,
    env,
    stdout: (line) => void out.push(line),
    stderr: (line) => void err.push(line),
    stdin: async () => {
      read += 1;
      return stdin;
    },
  });
  return { code, out, err, read };
}

/** A fake Keel whose person has signed in on this machine. */
async function signedIn(options: Parameters<typeof keel>[0] = {}, argv: readonly string[] = []) {
  const k = keel(options);
  expect(await run(["login", ...argv], k.io)).toBe(0);
  return k;
}

describe("keeltown auth git-credential", () => {
  it("[cli.git-credential] answers git with the sign-in held for the host it names, with no KEEL_URL and without asking Keel", async () => {
    const k = await signedIn();
    const before = k.sent.length;
    const got = await helper(k.io, asked("https", "keel.test", "path=ada/private.git\n"));
    expect(got.code).toBe(0);
    expect(got.out).toEqual(["username=ada", `password=${TOKEN}`]);
    expect(got.err).toEqual([]);
    expect(k.sent.length).toBe(before);
  });

  it("[cli.git-credential-host] gives nothing for a host it holds no sign-in for, and names the way to get one", async () => {
    const k = await signedIn();
    const other = await helper(k.io, asked("https", "other.example"));
    expect(other.code).toBe(0);
    expect(other.out).toEqual([]);
    expect(other.err.join("\n")).toContain("keeltown login");
    expect(other.err.join("\n")).toContain("other.example");
  });

  it("[cli.git-credential-env] KEEL_SESSION is given to KEEL_URL's host and to no other", async () => {
    const k = keel({ store: "none" });
    const env = { KEEL_URL: ORIGIN, KEEL_SESSION: "a-session-from-a-secret-manager" };
    const own = await helper(k.io, asked("https", "keel.test"), ["get"], env);
    expect(own.out).toEqual(["username=keeltown", "password=a-session-from-a-secret-manager"]);
    const other = await helper(k.io, asked("https", "git.example"), ["get"], env);
    expect(other.out).toEqual([]);
    const unnamed = await helper(k.io, asked("https", "keel.test"), ["get"], {
      KEEL_SESSION: "a-session-from-a-secret-manager",
    });
    expect(unnamed.out).toEqual([]);
  });

  it("[cli.git-credential-http] never answers over plain http, except to this machine itself", async () => {
    const k = await signedIn();
    const plain = await helper(k.io, asked("http", "keel.test"));
    expect(plain.code).toBe(0);
    expect(plain.out).toEqual([]);
    const local = await signedIn({ origin: "http://localhost:8787" });
    const loopback = await helper(local.io, asked("http", "localhost:8787"));
    expect(loopback.out).toEqual(["username=ada", `password=${TOKEN}`]);
  });

  it("[cli.git-credential-get-only] store and erase say nothing and leave the sign-in as it was", async () => {
    const k = await signedIn();
    const held = [...k.signIns.held];
    for (const op of ["store", "erase", "capability"]) {
      const did = await helper(
        k.io,
        asked("https", "keel.test", "username=ada\npassword=wrong\n"),
        [op],
      );
      expect(did.code).toBe(0);
      expect(did.out).toEqual([]);
      expect(did.read).toBe(0);
    }
    expect([...k.signIns.held]).toEqual(held);
  });

  it("[cli.git-credential-profile] under a profile it answers with that profile's sign-in and no other", async () => {
    const k = await signedIn({}, ["--profile", "work"]);
    const without = await helper(k.io, asked("https", "keel.test"));
    expect(without.out).toEqual([]);
    const within = await helper(k.io, asked("https", "keel.test"), ["--profile", "work", "get"]);
    expect(within.out).toEqual(["username=ada", `password=${TOKEN}`]);
  });
});

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const KEY = "credential.https://keel.test.helper";
/** Another helper, set for every host, as a machine's own git config may have one. */
const ANOTHER = `[credential]\n\thelper = "!f() { echo username=other; echo password=from-another-helper; }; f"\n`;

/** Stock git with its global config at `config`, the system's left out, and no prompt to fall back on. */
function gitWith(config: string, more: Record<string, string> = {}): Exec {
  return (file, args, stdin) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: config,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          ...more,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin ?? "");
    });
}

async function gitConfig() {
  const dir = await mkdtemp(join(tmpdir(), "keeltown-git-"));
  const config = join(dir, "gitconfig");
  await writeFile(config, ANOTHER);
  return { dir, config };
}

const lines = (text: string | undefined) => (text ?? "").replace(/\n$/, "").split("\n");

describe("keeltown auth setup-git", () => {
  it("[cli.setup-git] has stock git ask keeltown, and only keeltown, for Keel's host: the same two lines however often it runs", async () => {
    const { dir, config } = await gitConfig();
    try {
      const git = gitWith(config, { KEEL_URL: ORIGIN, KEEL_SESSION: TOKEN });
      const k = keel();
      const io: Io = { ...k.io, exec: git, self: [process.execPath, BIN] };
      expect(await run(["auth", "setup-git"], io)).toBe(0);
      const once = await git("git", ["config", "--global", "--get-all", KEY]);
      const [reset, ours, ...rest] = lines(once?.stdout);
      expect(reset).toBe("");
      expect(ours).toMatch(/^!.+ auth git-credential$/);
      expect(ours).toContain(BIN);
      expect(rest).toEqual([]);
      expect(await run(["auth", "setup-git"], io)).toBe(0);
      const twice = await git("git", ["config", "--global", "--get-all", KEY]);
      expect(twice?.stdout).toBe(once?.stdout);
      expect(k.out.at(-1)).toContain("keel.test");

      // git itself, asked for a credential as a clone asks: Keel's host is keeltown's alone.
      const keels = await git("git", ["credential", "fill"], "protocol=https\nhost=keel.test\n\n");
      expect(keels?.code).toBe(0);
      expect(keels?.stdout).toContain(`password=${TOKEN}\n`);
      expect(keels?.stdout).not.toContain("from-another-helper");
      // Every other host keeps the helper it had.
      const others = await git(
        "git",
        ["credential", "fill"],
        "protocol=https\nhost=git.example\n\n",
      );
      expect(others?.stdout).toContain("password=from-another-helper\n");
      expect(others?.stdout).not.toContain(TOKEN);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("[cli.setup-git-profile] under a profile, the line git runs names it", async () => {
    const { dir, config } = await gitConfig();
    try {
      const git = gitWith(config);
      const io: Io = { ...keel().io, exec: git, self: ["keeltown"] };
      expect(await run(["auth", "setup-git", "--profile", "work"], io)).toBe(0);
      const set = await git("git", ["config", "--global", "--get-all", KEY]);
      expect(lines(set?.stdout)).toEqual(["", "!keeltown auth git-credential --profile work"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("[cli.setup-git-quoted] a path with a space in it reaches git's shell as one word", async () => {
    const { dir, config } = await gitConfig();
    try {
      const git = gitWith(config);
      const io: Io = { ...keel().io, exec: git, self: ["/opt/my tools/node", "/it's/keeltown"] };
      expect(await run(["auth", "setup-git"], io)).toBe(0);
      const set = await git("git", ["config", "--global", "--get-all", KEY]);
      expect(lines(set?.stdout)[1]).toBe(
        `!'/opt/my tools/node' '/it'\\''s/keeltown' auth git-credential`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("[cli.setup-git-no-git] on a machine with no git it says so and exits 2", async () => {
    const k = keel();
    expect(await run(["auth", "setup-git"], { ...k.io, exec: async () => undefined })).toBe(2);
    expect(k.err.join("\n")).toMatch(/git/);
    expect(k.out).toEqual([]);
  });
});
