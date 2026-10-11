// S-1's five worlds, as the live harnesses build them: forge-lite's tracked
// files with S-1's patches applied by git, and A-noop from the freshness
// template's recipe. p4-staging.ts runs its probe across these; p6-staging.ts drafts against them.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  buildWorlds,
  freshnessNoop,
  type TextCodec,
} from "@keeltown/core/application/verification";
import type { World } from "@keeltown/core/domain/verification";
import type { BundleFile } from "@keeltown/runner-protocol";
import { Result } from "effect";
import { variantFiles } from "./bundles.ts";

export const FIXTURE = join(import.meta.dirname, "../../../../fixtures/forge-lite");

/** A's revoke call, which A-noop makes a no-op. */
export const RECIPE = freshnessNoop({
  path: "src/routes/collaborators.ts",
  call: "store.removeCollaborator(repo.id, target.id, actor.id, clock.now());",
});

/** What S26 saw for S-1 (and worlds.sh asserts): no revoke route on trunk or B, A holds, AB and A-noop break. */
export const S26: Readonly<Record<World, string>> = {
  trunk: "n/a",
  A: "pass",
  B: "n/a",
  AB: "fail",
  "A-noop": "fail",
};

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const codec: TextCodec<BundleFile> = {
  path: (f) => f.path,
  text: (f) => {
    try {
      return dec.decode(f.bytes);
    } catch {
      return undefined;
    }
  },
  withText: (f, text) => ({ ...f, bytes: enc.encode(text) }),
};

/** Every file under `root`, relative to it. */
const readTree = (root: string): BundleFile[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const path = join(e.parentPath, e.name);
      return { path: relative(root, path), bytes: new Uint8Array(readFileSync(path)) };
    });

/** forge-lite's tracked files with S-1's patches applied in order, as `git apply` from the fixture leaves them. */
const patched = (patches: readonly string[]): BundleFile[] => {
  const dir = mkdtempSync(join(tmpdir(), "keel-s1-world-"));
  for (const file of variantFiles("base")) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true });
    writeFileSync(join(dir, file.path), file.bytes);
  }
  for (const patch of patches)
    execFileSync("git", ["apply", join(FIXTURE, "scenarios", patch)], { cwd: dir });
  return readTree(dir);
};

/** S-1's five worlds: trunk, A, B, AB, and A with its revoke call made a no-op. */
export const s1Worlds = (): Readonly<Record<World, readonly BundleFile[]>> => {
  const built = buildWorlds(
    {
      trunk: patched([]),
      A: patched(["s1/a.patch"]),
      B: patched(["s1/b.patch"]),
      AB: patched(["s1/a.patch", "s1/b.patch"]),
    },
    RECIPE,
    codec,
  );
  if (Result.isFailure(built)) throw new Error(`no A-noop: ${JSON.stringify(built.failure)}`);
  return built.success;
};
