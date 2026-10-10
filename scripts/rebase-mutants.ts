// Re-derives mutant patches that went stale because the code they mutate was
// reformatted, not changed:
//   node scripts/rebase-mutants.ts <ref the patches were written against> [dir]
// For each patch that no longer applies: put its files back as they were at
// <ref>, apply the patch there, format those files with oxfmt, and diff them
// against HEAD. The header (`# expect-red`, `# kills`, `# why`) is kept. The
// files are restored afterwards, and a patch that still does not apply is
// reported. Formatting is behaviour-free, so each mutant keeps its meaning;
// prove:red is the check that it still kills what it claims.
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const [from, dirArg] = process.argv.slice(2);
if (from === undefined) {
  console.error("usage: node scripts/rebase-mutants.ts <ref> [dir]");
  process.exit(2);
}
const dir = resolve(root, dirArg ?? "test/mutants");
const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const oxfmt = join(root, "node_modules/.bin/oxfmt");

let rebased = 0;
const failed: string[] = [];
for (const name of readdirSync(dir)
  .filter((n) => n.endsWith(".patch"))
  .toSorted()) {
  const path = join(dir, name);
  if (git("apply", "--check", path).status === 0) continue;
  const text = readFileSync(path, "utf8");
  const header = text.slice(0, text.indexOf("diff --git"));
  const files = [...text.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1] ?? "");
  try {
    for (const file of files)
      writeFileSync(join(root, file), git("show", `${from}:${file}`).stdout);
    if (git("apply", path).status !== 0) {
      failed.push(`${name}: does not apply at ${from} either`);
      continue;
    }
    spawnSync(oxfmt, files, { cwd: root, encoding: "utf8" });
    const diff = git("diff", "--", ...files).stdout;
    if (diff === "") {
      failed.push(`${name}: formatting erased the mutation`);
      continue;
    }
    writeFileSync(path, header + diff);
  } finally {
    git("checkout", "--", ...files);
  }
  if (git("apply", "--check", path).status === 0) {
    rebased += 1;
  } else {
    failed.push(`${name}: rebuilt, but still does not apply`);
  }
}
console.log(`rebased ${rebased} patch(es)`);
for (const line of failed) console.log(`FAILED ${line}`);
process.exit(failed.length === 0 ? 0 : 1);
