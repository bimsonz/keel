// Proves that checks can fail. Each test/mutants/*.patch is a deliberate defect
// whose header names the check that must catch it and, for a property-test
// mutant, the tests it claims to kill:
//
//   # expect-red: pnpm exec vitest run --project unit packages/core/test/domain/x.test.ts
//   # kills: lattice.join-commutes, lattice.meet-idempotent
//
// A patch with `# kills:` tags runs its command with vitest's JSON reporter
// under each fixed seed (FC_SEED = 42, 1337, 20261014) and then N times with no
// seed. It counts red only if, in every run, every claimed tag has a failing
// test whose title carries `[tag]`; a non-zero exit is not enough, because one
// tag failing can hide another that passes. A patch without tags counts red
// when its command exits non-zero.
//
// Apply, run, revert: the tree is restored even when a step throws. Exit 1 if
// any mutant survived.
//
// Usage: node scripts/prove-red.ts [name-filter] [--unseeded N] [--dir <patch dir>]
//   --unseeded N   unseeded runs per tagged patch (default 5)
//   --dir          another patch directory (the runner's own control lives in
//                  test/controls/prove-red and must report a survivor)
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SEEDS = [42, 1337, 20_261_014] as const;

const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}
const unseeded = Number(option("--unseeded") ?? "5");
const dir = resolve(root, option("--dir") ?? "test/mutants");
const valued = new Set(["--unseeded", "--dir"]);
const filter =
  process.argv
    .slice(2)
    .find((arg, i, args) => !arg.startsWith("--") && !valued.has(args[i - 1] ?? "")) ?? "";
if (!Number.isInteger(unseeded) || unseeded < 0) {
  console.error("--unseeded takes a whole number of runs");
  process.exit(2);
}

const patches = readdirSync(dir)
  .filter((name) => name.endsWith(".patch") && name.includes(filter))
  .toSorted();

if (
  execSync("git status --porcelain --untracked-files=no", {
    cwd: root,
    encoding: "utf8",
  }).trim() !== ""
) {
  console.error("prove:red needs a clean working tree (tracked files); commit or stash first");
  process.exit(2);
}

interface Header {
  readonly command: string | undefined;
  readonly kills: readonly string[];
}

function headerOf(path: string): Header {
  const lines = readFileSync(path, "utf8").split("\n");
  const command = /^# expect-red: (.+)$/.exec(lines[0] ?? "")?.[1];
  const kills = lines
    .filter((line) => line.startsWith("# kills:"))
    .flatMap((line) => line.slice("# kills:".length).split(","))
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  return { command, kills };
}

/** Each `[tag]` in a test's full name, with whether that test failed. */
function tagsIn(report: unknown): { readonly failed: Set<string>; readonly seen: Set<string> } {
  const failed = new Set<string>();
  const seen = new Set<string>();
  const files: unknown = Reflect.get(Object(report), "testResults");
  for (const file of Array.isArray(files) ? files : []) {
    const assertions: unknown = Reflect.get(Object(file), "assertionResults");
    for (const assertion of Array.isArray(assertions) ? assertions : []) {
      const name = String(Reflect.get(Object(assertion), "fullName") ?? "");
      const status = Reflect.get(Object(assertion), "status");
      for (const [, tag] of name.matchAll(/\[([\w.-]+)\]/g)) {
        if (tag === undefined) continue;
        seen.add(tag);
        if (status === "failed") failed.add(tag);
      }
    }
  }
  return { failed, seen };
}

function excerpt(output: string): string {
  return output
    .split("\n")
    .filter((line) => /×|FAIL|error TS|AssertionError|Error:|Tests |expected/.test(line))
    .slice(0, 6)
    .map((line) => `       ${line.trim()}`)
    .join("\n");
}

/** Runs a tagged patch's command once per seed and per unseeded run; answers why it survived, or null. */
function killsEveryTag(command: string, kills: readonly string[]): string | null {
  const scratch = mkdtempSync(join(tmpdir(), "prove-red-"));
  try {
    const runs = [
      ...SEEDS.map((seed) => ({ label: `seed ${seed}`, seed: String(seed) })),
      ...Array.from({ length: unseeded }, (_, i) => ({
        label: `unseeded run ${i + 1}`,
        seed: undefined,
      })),
    ];
    for (const [index, run] of runs.entries()) {
      const report = join(scratch, `${index}.json`);
      const env: NodeJS.ProcessEnv = { ...process.env, FC_SEED: run.seed };
      if (run.seed === undefined) delete env["FC_SEED"];
      const result = spawnSync(
        `${command} --reporter=json --outputFile=${JSON.stringify(report)}`,
        { cwd: root, shell: true, encoding: "utf8", env },
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(report, "utf8"));
      } catch {
        return `${run.label}: no JSON report (exit ${result.status}); the suite did not run\n${excerpt(`${result.stdout}${result.stderr}`)}`;
      }
      const { failed, seen } = tagsIn(parsed);
      const unseen = kills.filter((tag) => !seen.has(tag));
      if (unseen.length > 0)
        return `${run.label}: no test carries ${unseen.map((t) => `[${t}]`).join(", ")}`;
      const green = kills.filter((tag) => !failed.has(tag));
      if (green.length > 0)
        return `${run.label}: ${green.map((t) => `[${t}]`).join(", ")} stayed green`;
    }
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const survivors: string[] = [];
for (const name of patches) {
  const path = join(dir, name);
  const { command, kills } = headerOf(path);
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
    if (kills.length > 0) {
      const survived = killsEveryTag(command, kills);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (survived === null) {
        console.log(
          `red ${name} (${seconds}s): ${kills.map((t) => `[${t}]`).join(", ")} failed under seeds ${SEEDS.join(", ")} and ${unseeded} unseeded run(s)`,
        );
      } else {
        survivors.push(name);
        console.log(`SURVIVED ${name} (${seconds}s): ${survived}`);
      }
    } else {
      const run = spawnSync(command, { cwd: root, shell: true, encoding: "utf8" });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (run.status === 0) {
        survivors.push(name);
        console.log(`SURVIVED ${name} (${seconds}s): \`${command}\` stayed green`);
      } else {
        console.log(
          `red ${name} (${seconds}s, exit ${run.status}): \`${command}\`\n${excerpt(`${run.stdout}${run.stderr}`)}`,
        );
      }
    }
  } finally {
    execSync(`git apply -R ${JSON.stringify(path)}`, { cwd: root });
  }
}

console.log(
  survivors.length === 0
    ? `\nall ${patches.length} mutants went red`
    : `\nsurvivors: ${survivors.join(", ")}`,
);
process.exit(survivors.length === 0 ? 0 : 1);
