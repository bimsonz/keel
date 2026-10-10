import { execFileSync } from "node:child_process";
import {
  appendFileSync,
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
