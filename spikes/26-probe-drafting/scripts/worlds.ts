// Builds the probe worlds and the drafting input from the forge-lite fixture.
//
//   node scripts/worlds.ts <fixture-dir> <scratch-dir>
//
// Each world is a copy of the fixture in <scratch-dir>/worlds/<name> with its
// patches applied by `git apply` (outside any repository, so it acts as a
// plain patch tool). Writes <scratch-dir>/worlds.json, the src/ tree of each
// world, and <scratch-dir>/draft-input.json, the input to draftProbe.
//
// Worlds:
//   base     the fixture
//   A        base + s1/a.patch                 (premise holder: revoke route)
//   B        base + s1/b.patch                 (per-session role cache)
//   AB       base + s1/a.patch + s1/b.patch
//   mutantA  A with the revoke made a no-op: the route still answers 204,
//            but nothing is removed. A non-vacuous probe must fail here.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [fixture, scratch] = process.argv.slice(2);
if (!fixture || !scratch) throw new Error("usage: node scripts/worlds.ts <fixture-dir> <scratch-dir>");

const WORLDS: Record<string, string[]> = {
  base: [],
  A: ["s1/a.patch"],
  B: ["s1/b.patch"],
  AB: ["s1/a.patch", "s1/b.patch"],
  mutantA: ["s1/a.patch"],
};

const REVOKE_CALL = "    store.removeCollaborator(repo.id, target.id, actor.id, clock.now());\n";
const REVOKE_NOOP = "    // mutant: the revoke is a no-op; the route answers 204 and nothing is removed.\n    void actor;\n";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const root = join(scratch, "worlds");
rmSync(root, { recursive: true, force: true });
const worlds: Record<string, Record<string, string>> = {};
for (const [name, patches] of Object.entries(WORLDS)) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const entry of ["src", "package.json", "scenarios"]) cpSync(join(fixture, entry), join(dir, entry), { recursive: true });
  for (const patch of patches) execFileSync("git", ["apply", join("scenarios", patch)], { cwd: dir, stdio: "pipe" });
  if (name === "mutantA") {
    const file = join(dir, "src/routes/collaborators.ts");
    const text = readFileSync(file, "utf8");
    if (!text.includes(REVOKE_CALL)) throw new Error("mutantA: revoke call not found in A's collaborators.ts");
    writeFileSync(file, text.replace(REVOKE_CALL, REVOKE_NOOP));
  }
  const files: Record<string, string> = { "package.json": readFileSync(join(dir, "package.json"), "utf8") };
  for (const p of walk(join(dir, "src"))) files[relative(dir, p)] = readFileSync(p, "utf8");
  worlds[name] = files;
  console.log(`${name.padEnd(8)} ${Object.keys(files).length} files, ${Object.values(files).reduce((a, s) => a + s.length, 0)} chars`);
}
writeFileSync(join(scratch, "worlds.json"), JSON.stringify(worlds));

// ---------------------------------------------------------------------------
// The drafting input: propositions, anchors, source excerpts, patch hunks.

// The source a probe author needs: all of base src/ except the Worker entry
// (about 53 KB, ~14k tokens). A first selection that left out the validation
// rules (src/domain/names.ts, src/auth/passwords.ts) let a draft fail at its
// own setup (POST /users -> 422), so nothing the scenario passes through is
// left out. The budget still fits a 32k-context model.
const SOURCE_FILES = Object.keys(worlds.base!)
  .filter((f) => f.startsWith("src/") && f !== "src/index.ts")
  .toSorted();

/** The diff hunks of a patch that touch src/, without its prose header or test files. */
function srcHunks(patch: string): string {
  const parts = patch.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "));
  return parts.filter((p) => p.startsWith("diff --git a/src/")).join("");
}

const sources = Object.fromEntries(SOURCE_FILES.map((f) => [f, worlds.base![f]!]));
const hunks = {
  "A (scenarios/s1/a.patch)": srcHunks(readFileSync(join(fixture, "scenarios/s1/a.patch"), "utf8")),
  "B (scenarios/s1/b.patch)": srcHunks(readFileSync(join(fixture, "scenarios/s1/b.patch"), "utf8")),
};
const input = {
  propositions: {
    premise: {
      holder: "A",
      subject: "authz.permission-evaluation",
      predicate: "freshness",
      relation: "<=",
      value: "per-request",
    },
    derivedEffect: {
      holder: "B",
      subject: "authz.permission-evaluation",
      predicate: "freshness",
      relation: "=",
      value: "per-session",
    },
  },
  anchors: [
    { kind: "symbol", file: "src/authz/require-permission.ts", symbol: "requirePermission", note: "where permission freshness is decided" },
    {
      kind: "route",
      patch: "A",
      file: "src/routes/collaborators.ts",
      route: "DELETE /repos/:owner/:repo/collaborators/:username",
      note: "the revoke route A adds; it is the premise's precondition",
    },
  ],
  sources,
  hunks,
};
writeFileSync(join(scratch, "draft-input.json"), JSON.stringify(input));
const srcChars = Object.values(sources).reduce((a, s) => a + s.length, 0);
const hunkChars = Object.values(hunks).reduce((a, s) => a + s.length, 0);
console.log(`draft input: ${SOURCE_FILES.length} source files (${srcChars} chars), hunks ${hunkChars} chars`);
