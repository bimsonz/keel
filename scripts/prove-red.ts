// Proves that checks can fail. Each test/mutants/*.patch is a deliberate defect
// whose first line names the check that must catch it:
//
//   # expect-red: pnpm exec vitest run --project pool:keel apps/keel/test/pool/whoami.test.ts
//
// For every patch: apply it, run the command, require a non-zero exit, revert.
// The tree is restored even when a step throws. Exit 1 if any mutant survived.
// Usage: node scripts/prove-red.ts [name-filter]
import { execSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const dir = join(root, "test/mutants");
const filter = process.argv[2] ?? "";
const patches = readdirSync(dir).filter((name) => name.endsWith(".patch") && name.includes(filter)).toSorted();

if (execSync("git status --porcelain --untracked-files=no", { cwd: root, encoding: "utf8" }).trim() !== "") {
  console.error("prove:red needs a clean working tree (tracked files); commit or stash first");
  process.exit(2);
}

const survivors: string[] = [];
for (const name of patches) {
  const path = join(dir, name);
  const header = readFileSync(path, "utf8").split("\n")[0] ?? "";
  const command = /^# expect-red: (.+)$/.exec(header)?.[1];
  if (command === undefined) {
    console.log(`SKIP ${name}: first line must be "# expect-red: <command>"`);
    survivors.push(name);
    continue;
  }
  if (spawnSync("git", ["apply", "--check", path], { cwd: root }).status !== 0) {
    console.log(`STALE ${name}: no longer applies to the code it mutates; regenerate it`);
    survivors.push(name);
    continue;
  }
  execSync(`git apply ${JSON.stringify(path)}`, { cwd: root });
  try {
    const started = Date.now();
    const run = spawnSync(command, { cwd: root, shell: true, encoding: "utf8" });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const tail = `${run.stdout}${run.stderr}`
      .split("\n")
      .filter((line) => /×|FAIL|error TS|AssertionError|Error:|Tests |expected/.test(line))
      .slice(0, 6)
      .map((line) => `       ${line.trim()}`)
      .join("\n");
    if (run.status === 0) {
      survivors.push(name);
      console.log(`SURVIVED ${name} (${seconds}s): \`${command}\` stayed green`);
    } else {
      console.log(`red ${name} (${seconds}s, exit ${run.status}): \`${command}\`\n${tail}`);
    }
  } finally {
    execSync(`git apply -R ${JSON.stringify(path)}`, { cwd: root });
  }
}

console.log(survivors.length === 0 ? `\nall ${patches.length} mutants went red` : `\nsurvivors: ${survivors.join(", ")}`);
process.exit(survivors.length === 0 ? 0 : 1);
