// Proves that checks can fail. Each test/mutants/*.patch is a deliberate defect
// whose header names the check that must catch it and, for a property-test
// mutant, the tests it claims to kill:
//
//   # expect-red: pnpm exec vitest run --project unit packages/core/test/domain/x.test.ts
//   # kills: lattice.join-commutes, lattice.meet-idempotent
//
// A patch with `# kills:` tags runs its command with vitest's JSON reporter
// under each fixed seed (FC_SEED = 42, 1337, 20261014) and then N times with no
// seed. Unless the command names its own tests with `-t`, it runs only the
// tests that carry a claimed tag (`-t '\[tag-a\]|\[tag-b\]'` is added), and the
// result line says how many of the tests it found ran. It counts red only if,
// in every run, every claimed tag has a failing test whose title carries
// `[tag]`; a non-zero exit is not enough, because one tag failing can hide
// another that passes. A patch without tags counts red when its command exits
// non-zero. A patch to the spec carries `# regen`: the generated code is
// gitignored, so `pnpm gen` runs after applying it and again after reverting
// it, and no later mutant runs against its generated output.
//
// Before a patch is applied, its command runs once with no patch, under
// FC_SEED 42: the baseline. A claimed tag that fails there, or has no test, or
// a run that leaves no report, is reported `BASELINE RED` and the patch is
// never applied: a test that fails by itself proves nothing about the mutant.
// An untagged patch's command must exit 0 there. Patches that share a command
// share one baseline run.
//
// Apply, run, revert: the tree is restored even when a step throws. Exit 1 if
// any mutant survived or met a red baseline. The rules themselves are in
// packages/tooling/src/prove-red.ts, where a test can reach them: this script
// refuses a dirty tree, so it cannot run under its own mutants.
//
// `--baseline-only` is the sweep: it takes the baselines and applies nothing,
// so it proves no mutant. It runs each command once, narrowed to every tag the
// patches that share it claim, and says of each patch `baseline green` or
// `BASELINE RED`. It finds the patches whose proof would be a lie at the cost
// of one run for each command, where a full proof takes six for each patch.
// Exit 1 if any baseline is red, or any patch is stale or has no header.
//
// Usage: node scripts/prove-red.ts [name-filter] [--unseeded N] [--dir <patch dir>] [--baseline-only]
//   --unseeded N      unseeded runs per tagged patch (default 2)
//   --dir             another patch directory (the runner's own controls live
//                     in test/controls/prove-red: one must be reported a
//                     survivor, the other BASELINE RED)
//   --baseline-only   take every baseline, apply no patch
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  argumentsOf,
  prover,
  type Ran,
  type Run,
  sweeper,
} from "../packages/tooling/src/prove-red.ts";

const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

const asked = argumentsOf(process.argv.slice(2));
if ("refused" in asked) {
  console.error(asked.refused);
  process.exit(2);
}
const { filter, unseeded, baselineOnly } = asked;
const dir = resolve(root, asked.dir ?? "test/mutants");

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
  readonly regen: boolean;
}

function headerOf(path: string): Header {
  const lines = readFileSync(path, "utf8").split("\n");
  const command = /^# expect-red: (.+)$/.exec(lines[0] ?? "")?.[1];
  const kills = lines
    .filter((line) => line.startsWith("# kills:"))
    .flatMap((line) => line.slice("# kills:".length).split(","))
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  return { command, kills, regen: lines.some((line) => line.trim() === "# regen") };
}

function regenerate(): void {
  execSync("pnpm gen", { cwd: root, stdio: "ignore" });
}

/** One run of a command in the tree as it stands. A report nobody wrote reads as none. */
function run(scratch: string, index: number, { command, seed, reported }: Run): Ran {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (seed === undefined) delete env["FC_SEED"];
  else env["FC_SEED"] = String(seed);
  const report = join(scratch, `${index}.json`);
  const result = spawnSync(
    reported ? `${command} --reporter=json --outputFile=${JSON.stringify(report)}` : command,
    { cwd: root, shell: true, encoding: "utf8", env },
  );
  let parsed: unknown;
  if (reported) {
    try {
      parsed = JSON.parse(readFileSync(report, "utf8"));
    } catch {
      parsed = undefined;
    }
  }
  return { status: result.status, report: parsed, output: `${result.stdout}${result.stderr}` };
}

/** A patch that can be run: it has its header and still applies. */
interface Usable {
  readonly name: string;
  readonly path: string;
  readonly command: string;
  readonly kills: readonly string[];
  readonly regen: boolean;
}

/** The patch, or nothing once it is reported as one that cannot be run. */
function usable(name: string): Usable | undefined {
  const path = join(dir, name);
  const { command, kills, regen } = headerOf(path);
  if (command === undefined) {
    console.log(`SKIP ${name}: first line must be "# expect-red: <command>"`);
    return undefined;
  }
  if (spawnSync("git", ["apply", "--check", path], { cwd: root }).status !== 0) {
    console.log(`STALE ${name}: no longer applies to the code it mutates; regenerate it`);
    return undefined;
  }
  return { name, path, command, kills, regen };
}

/** Patches that survived, or that could not be run: in a sweep, only the second. */
const survivors: string[] = [];
const baselineRed: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), "prove-red-"));
try {
  let runs = 0;
  const numbered = (wanted: Run): Ran => run(scratch, runs++, wanted);
  if (baselineOnly) {
    const mutants = patches.flatMap((name) => {
      const patch = usable(name);
      if (patch === undefined) survivors.push(name);
      return patch === undefined ? [] : [patch];
    });
    const baselineOf = sweeper({ run: numbered, mutants });
    for (const { name, command, kills } of mutants) {
      const baseline = baselineOf({ command, kills });
      if (baseline.verdict === "baseline-red") {
        baselineRed.push(name);
        console.log(`BASELINE RED ${name}: ${baseline.detail}`);
      } else console.log(`baseline green ${name} (${baseline.note})`);
    }
  } else {
    const prove = prover({ run: numbered, unseeded });
    for (const name of patches) {
      const patch = usable(name);
      if (patch === undefined) {
        survivors.push(name);
        continue;
      }
      const { path, command, kills, regen } = patch;
      const mutated = <T>(body: () => T): T => {
        execSync(`git apply ${JSON.stringify(path)}`, { cwd: root });
        try {
          if (regen) regenerate();
          return body();
        } finally {
          execSync(`git apply -R ${JSON.stringify(path)}`, { cwd: root });
          if (regen) regenerate();
        }
      };
      const started = Date.now();
      const { verdict, note, detail } = prove({ command, kills, mutated });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (verdict === "baseline-red") {
        baselineRed.push(name);
        console.log(`BASELINE RED ${name}: ${detail}`);
        continue;
      }
      if (verdict === "survived") survivors.push(name);
      const timing = note === "" ? `${seconds}s` : `${seconds}s, ${note}`;
      console.log(`${verdict === "red" ? "red" : "SURVIVED"} ${name} (${timing}): ${detail}`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const unproven = survivors.length + baselineRed.length;
const allGood = baselineOnly
  ? `all ${patches.length} baselines green; nothing was applied, so no mutant is proved`
  : `all ${patches.length} mutants went red`;
console.log(
  unproven === 0
    ? `\n${allGood}`
    : [
        ...(survivors.length === 0
          ? []
          : [`\n${baselineOnly ? "stale or headerless" : "survivors"}: ${survivors.join(", ")}`]),
        ...(baselineRed.length === 0
          ? []
          : [`\nbaseline red, so nothing proved: ${baselineRed.join(", ")}`]),
      ].join(""),
);
process.exit(unproven === 0 ? 0 : 1);
