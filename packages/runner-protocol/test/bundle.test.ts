import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLE_MANIFEST,
  type BundleFile,
  BundleRefused,
  DIAGNOSE_BUNDLE_SH,
  HYDRATE_SH,
  manifestOf,
  sha256Hex,
  VERIFY_BUNDLE_SH,
  writeBundle,
} from "../src/index.ts";

const enc = new TextEncoder();
const file = (path: string, text: string, executable?: boolean): BundleFile => ({
  path,
  bytes: enc.encode(text),
  ...(executable === undefined ? {} : { executable }),
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Extracts a bundle exactly as the sandbox's archive checkout does: `tar -xz --strip-components=1`. */
const extract = (bundle: Uint8Array): string => {
  const dir = mkdtempSync(join(tmpdir(), "keel-bundle-"));
  dirs.push(dir);
  const archive = join(dir, "..", `${dir.split("/").at(-1)}.tgz`);
  writeFileSync(archive, bundle);
  execFileSync("tar", ["-xz", "--strip-components=1", "-C", dir, "-f", archive]);
  rmSync(archive);
  return dir;
};

const walk = (root: string, dir = root): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(root, path) : [relative(root, path)];
  });

const LONG = `${"deep/".repeat(30)}file.ts`;

describe("candidate bundles", () => {
  it("extract under --strip-components=1 to exactly the files plus the manifest", async () => {
    const files = [
      file("package.json", "{}\n"),
      file("src/index.ts", "export {};\n"),
      file("scripts/run.sh", "#!/bin/sh\n", true),
      file(LONG, "long\n"),
    ];
    const dir = extract(await writeBundle(files));
    expect(walk(dir).toSorted()).toEqual([...files.map((f) => f.path), BUNDLE_MANIFEST].toSorted());
    for (const f of files)
      expect(readFileSync(join(dir, f.path), "utf8")).toBe(new TextDecoder().decode(f.bytes));
    expect(statSync(join(dir, "scripts/run.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(dir, "package.json")).mode & 0o111).toBe(0);
  });

  it("carry a manifest that matches the extracted tree, line for line", async () => {
    const files = [file("b.txt", "b"), file("a/c.txt", "c"), file("a.txt", "a")];
    const dir = extract(await writeBundle(files));
    const manifest = readFileSync(join(dir, BUNDLE_MANIFEST), "utf8");
    expect(manifest).toBe(await manifestOf(files));
    const lines = manifest.trimEnd().split("\n");
    expect(lines.map((l) => l.slice(66))).toEqual(["a.txt", "a/c.txt", "b.txt"]);
    for (const line of lines) {
      const [digest, path] = [line.slice(0, 64), line.slice(66)];
      expect(digest).toBe(await sha256Hex(readFileSync(join(dir, path))));
    }
  });

  it("are content-addressed: the same files give the same bytes, a changed file different ones", async () => {
    const a = await writeBundle([file("x", "1"), file("y", "2")]);
    const b = await writeBundle([file("y", "2"), file("x", "1")]);
    const c = await writeBundle([file("x", "1"), file("y", "3")]);
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(c));
  });

  it("refuse unsafe, duplicate or reserved paths", async () => {
    for (const path of ["", "/etc/passwd", "../up", "a/../b", "a//b", "./a", BUNDLE_MANIFEST]) {
      await expect(writeBundle([file(path, "x")])).rejects.toBeInstanceOf(BundleRefused);
    }
    await expect(writeBundle([file("a", "1"), file("a", "2")])).rejects.toBeInstanceOf(
      BundleRefused,
    );
  });
});

/** Runs `keel_verify_bundle` in `dir`, as a runner does before it runs anything. */
const verify = (dir: string): { ok: boolean; reason: string } => {
  try {
    execFileSync("sh", ["-c", `${VERIFY_BUNDLE_SH}\nkeel_verify_bundle`], {
      cwd: dir,
      encoding: "utf8",
    });
    return { ok: true, reason: "" };
  } catch (error) {
    const stdout = error instanceof Error && "stdout" in error ? error.stdout : "";
    return { ok: false, reason: String(stdout).trim() };
  }
};

describe("verifying an extracted bundle", () => {
  const files = [
    file("package.json", "{}\n"),
    file("src/a.ts", "a\n"),
    file("test/a.test.ts", "t\n"),
  ];

  it("[bundle.verify-complete] accepts exactly the bundle's tree", async () => {
    expect(verify(extract(await writeBundle(files)))).toEqual({ ok: true, reason: "" });
  });

  it("[bundle.verify-partial] refuses a tree missing a file, with a changed file, or with no manifest", async () => {
    const bundle = await writeBundle(files);
    const missing = extract(bundle);
    rmSync(join(missing, "test/a.test.ts"));
    const changed = extract(bundle);
    appendFileSync(join(changed, "src/a.ts"), "tampered\n");
    const unlisted = extract(bundle);
    rmSync(join(unlisted, BUNDLE_MANIFEST));
    expect([verify(missing), verify(changed), verify(unlisted)]).toEqual([
      { ok: false, reason: "hash-mismatch" },
      { ok: false, reason: "hash-mismatch" },
      { ok: false, reason: "no-manifest" },
    ]);
  });

  it("[bundle.verify-extra] refuses a tree with a file the manifest does not list", async () => {
    const dir = extract(await writeBundle(files));
    writeFileSync(join(dir, "src/injected.ts"), "x\n");
    expect(verify(dir)).toEqual({ ok: false, reason: "count-4-of-3" });
  });

  it("[bundle.verify-partial] refuses what a truncated download extracts to", async () => {
    const bundle = await writeBundle([...files, file("big.txt", "x".repeat(200_000))]);
    const dir = mkdtempSync(join(tmpdir(), "keel-bundle-"));
    dirs.push(dir);
    const archive = `${dir}.tgz`;
    writeFileSync(archive, bundle.slice(0, Math.floor(bundle.length / 2)));
    try {
      execFileSync("tar", ["-xz", "--strip-components=1", "-C", dir, "-f", archive], {
        stdio: "ignore",
      });
    } catch {
      // The checkout never checks tar's exit code either.
    }
    rmSync(archive);
    expect(verify(dir).ok).toBe(false);
  });
});

/** Runs `keel_bundle_diff` in `dir`, as the suite command does once `keel_verify_bundle` refuses it. */
const diagnose = (dir: string, url = ""): string[] => {
  const scratch = mkdtempSync(join(tmpdir(), "keel-diag-"));
  dirs.push(scratch);
  return execFileSync(
    "sh",
    ["-c", `${VERIFY_BUNDLE_SH}\n${DIAGNOSE_BUNDLE_SH}\nkeel_bundle_diff "$0" "$1"`, scratch, url],
    { cwd: dir, encoding: "utf8" },
  )
    .split("\n")
    .filter((l) => l.length > 0);
};

/** Text that gzip cannot shrink much, so cutting an archive in half really loses files. */
const noise = (bytes: number) => randomBytes(bytes).toString("base64");

describe("diagnosing a refused tree", () => {
  it("[bundle.diagnose-short] names a short download's missing entries at the archive's end, beside a clean refetch", async () => {
    const files = [
      file("a.txt", "a\n"),
      file("b.bin", noise(30_000)),
      file("c.bin", noise(30_000)),
      file("d.bin", noise(30_000)),
    ];
    const bundle = await writeBundle(files);
    const hash = await sha256Hex(bundle);
    const served = mkdtempSync(join(tmpdir(), "keel-served-"));
    dirs.push(served);
    writeFileSync(join(served, hash), bundle);
    // What GNU tar (the sandbox's) leaves of a download cut inside c.bin: a and b
    // whole, c cut short, d never reached. bsdtar leaves nothing, so build it.
    const dir = extract(bundle);
    rmSync(join(dir, "d.bin"));
    writeFileSync(join(dir, "c.bin"), readFileSync(join(dir, "c.bin")).subarray(0, 10_000));
    const out = diagnose(dir, `file://${join(served, hash)}`);
    const bad = out.flatMap((l) => {
      const m = /^entry (\d+) (\S+) (missing|differs)/.exec(l);
      return m === null ? [] : [{ n: Number(m[1]), path: m[2], why: m[3] }];
    });
    // A short download loses a run of entries ending with the last one.
    expect(bad).toEqual([
      { n: 3, path: "c.bin", why: "differs" },
      { n: 4, path: "d.bin", why: "missing" },
    ]);
    expect(out).toContain("entries 2 of 4 bad");
    expect(out.find((l) => l.startsWith("refetch curl "))).toMatch(
      new RegExp(`^refetch curl 0 http \\d+ bytes ${bundle.length} sha256 ${hash} want ${hash}$`),
    );
    expect(out).toEqual(
      expect.arrayContaining(["refetch gzip ok", "refetch tar ok", "refetch verifies ok"]),
    );
    expect(out.some((l) => l.startsWith("vs-refetch ") && l.includes("d.bin"))).toBe(true);
  });

  it("[bundle.diagnose-differs] names a changed file, and a refetch that is itself short", async () => {
    const files = [file("a.txt", "a\n"), file("b.txt", "b\n"), file("c.bin", noise(30_000))];
    const bundle = await writeBundle(files);
    const dir = extract(bundle);
    appendFileSync(join(dir, "a.txt"), "tampered\n");
    const served = mkdtempSync(join(tmpdir(), "keel-served-"));
    dirs.push(served);
    const hash = await sha256Hex(bundle);
    writeFileSync(join(served, hash), bundle.slice(0, Math.floor(bundle.length / 2)));
    const out = diagnose(dir, `file://${join(served, hash)}`);
    expect(out).toContain("entry 1 a.txt differs 11B");
    expect(out).toContain("entries 1 of 3 bad");
    expect(out).toContain("refetch gzip bad");
    expect(out.find((l) => l.startsWith("refetch verifies "))).toMatch(/^refetch verifies no: /);
  });

  it("[bundle.diagnose-differs] says when it has no URL to refetch from", async () => {
    const dir = extract(await writeBundle([file("a.txt", "a\n")]));
    expect(diagnose(dir)).toEqual([
      "entries 0 of 1 bad",
      "workspace files 2 bytes " + String(statSync(join(dir, BUNDLE_MANIFEST)).size + 2),
      "refetch skipped: no url",
    ]);
  });
});

const scratchDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** Serves `bytes` as a bundle host would: at a path ending in the hash it is fetched by. */
const serve = (hash: string, bytes: Uint8Array) => {
  const dir = scratchDir("keel-served-");
  writeFileSync(join(dir, hash), bytes);
  return `file://${join(dir, hash)}`;
};

/**
 * Runs `keel_hydrate` in `dir`, as the suite command does, with a `curl` on
 * PATH that logs each call before running the real one.
 */
const hydrate = (dir: string, url: string) => {
  const bin = scratchDir("keel-bin-");
  const log = join(bin, "curl.log");
  const real = execFileSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "curl"), `#!/bin/sh\necho "$*" >> ${log}\nexec ${real} "$@"\n`);
  chmodSync(join(bin, "curl"), 0o755);
  const run = spawnSync(
    "sh",
    ["-c", `${HYDRATE_SH}\nkeel_hydrate "$0" "$1"`, scratchDir("keel-scratch-"), url],
    { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}` } },
  );
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return {
    status: run.status,
    lines: run.stdout.split("\n").filter(Boolean),
    refetches: calls.filter((c) => c.includes("/rehydrate/")).length,
  };
};

const snapshot = (dir: string) =>
  walk(dir)
    .toSorted()
    .map((path) => `${path}:${readFileSync(join(dir, path), "utf8").length}`);

describe("hydrating a runner's workspace", () => {
  const files = [
    file("package.json", "{}\n"),
    file("src/a.ts", "a\n"),
    file("test/a.test.ts", "t\n"),
  ];

  it("passes a tree that verifies as extracted, fetching nothing", async () => {
    const bundle = await writeBundle(files);
    const result = hydrate(extract(bundle), serve(await sha256Hex(bundle), bundle));
    expect(result).toEqual({ status: 0, lines: ["KEEL_HYDRATION ok"], refetches: 0 });
  });

  it("[bundle.rehydrate-verified] refetches a bad tree once by its content address, and says so first", async () => {
    const bundle = await writeBundle(files);
    const dir = extract(bundle);
    rmSync(join(dir, "test/a.test.ts"));
    const result = hydrate(dir, serve(await sha256Hex(bundle), bundle));
    expect(result.status).toBe(0);
    expect(result.lines[0]).toBe("KEEL_HYDRATION_RETRIED hash-mismatch");
    expect(result.lines[1]).toMatch(/^KEEL_HYDRATION_DIFF [A-Za-z0-9+/]+=*$/);
    expect(result.lines.slice(2)).toEqual(["KEEL_HYDRATION ok"]);
    expect(verify(dir)).toEqual({ ok: true, reason: "" });
  });

  it("[bundle.rehydrate-verified] refuses a refetch that is not the bundle it was addressed by, and leaves the tree alone", async () => {
    const bundle = await writeBundle(files);
    const other = await writeBundle([file("package.json", "{}\n"), file("evil.ts", "x\n")]);
    const dir = extract(bundle);
    rmSync(join(dir, "test/a.test.ts"));
    const before = snapshot(dir);
    // A whole, valid bundle, but not this one: only its sha256 can tell.
    const result = hydrate(dir, serve(await sha256Hex(bundle), other));
    expect(result.status).toBe(1);
    expect(result.lines.at(-1)).toBe("KEEL_HYDRATION failed hash-mismatch");
    expect(result.lines.some((l) => l.startsWith("KEEL_HYDRATION_RETRIED"))).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });

  it("[bundle.rehydrate-once] never refetches a second time", async () => {
    const bundle = await writeBundle(files);
    const dir = extract(bundle);
    appendFileSync(join(dir, "src/a.ts"), "tampered\n");
    const result = hydrate(dir, serve(await sha256Hex(bundle), bundle.slice(0, 40)));
    expect(result.status).toBe(1);
    expect(result.lines.at(-1)).toBe("KEEL_HYDRATION failed hash-mismatch");
    expect(result.refetches).toBe(1);
  });
});
