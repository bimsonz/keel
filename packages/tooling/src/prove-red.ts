// How `scripts/prove-red.ts` decides whether a mutant went red: what it adds to
// the mutant's command so that it runs only the tests the mutant claims to
// kill, the baseline it takes before the patch is applied, and the rule for
// red. Pure: the script does the running and the patching, and hands both in.

const escaped = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** Whether a command already says which tests to run, by `-t` or `--testNamePattern`. */
const namesItsTests = (command: string): boolean =>
  /(?:^|\s)(?:-t|--testNamePattern)(?:[\s=]|$)/.test(command);

/** A vitest name pattern matching exactly the titles that carry one of these tags as `[tag]`. */
export function claimedPattern(kills: readonly string[]): string {
  return kills.map((tag) => escaped(`[${tag}]`)).join("|");
}

/**
 * The command narrowed to the tests it claims: `-t '<pattern>'` appended,
 * quoted for the shell. A command with no claims, or one that already names
 * its tests, comes back as written.
 */
export function filteredToClaims(command: string, kills: readonly string[]): string {
  if (kills.length === 0 || namesItsTests(command)) return command;
  return `${command} -t ${quoted(claimedPattern(kills))}`;
}

/** The fixed seeds every tagged mutant runs under. The baseline runs under the first. */
export const SEEDS = [42, 1337, 20_261_014] as const;

/** One run the prover asks for, in the tree as it stands. */
export interface Run {
  readonly command: string;
  /** FC_SEED for the run. `undefined` runs with none. */
  readonly seed: number | undefined;
  /** Whether to ask vitest for its JSON report: a tagged mutant is scored from it. */
  readonly reported: boolean;
}

/** What a run gave back. */
export interface Ran {
  readonly status: number | null;
  /** Vitest's JSON report, parsed. `undefined` when none was asked for, or none was written. */
  readonly report: unknown;
  /** Everything the command printed. */
  readonly output: string;
}

export interface Mutant {
  /** The header's command, as written. */
  readonly command: string;
  /** The tags the header claims. None means the exit code decides. */
  readonly kills: readonly string[];
  /** Runs `body` with the patch applied, and reverts the patch whatever `body` does. */
  readonly mutated: <T>(body: () => T) => T;
}

export interface Proof {
  /**
   * `baseline-red` is a mutant that proved nothing: its command already fails
   * with no patch applied. It is never red, and its patch is never applied.
   */
  readonly verdict: "red" | "survived" | "baseline-red";
  /** What the result line adds after the seconds: `2 of 15 tests`, `exit 1`, or nothing. */
  readonly note: string;
  readonly detail: string;
}

interface Tally {
  readonly failed: Set<string>;
  readonly seen: Set<string>;
  /** Tests that ran, of the tests the report lists: a name filter leaves the rest skipped. */
  readonly ran: number;
  readonly listed: number;
}

/** Each `[tag]` in a test's full name, with whether that test failed, and how many tests ran. */
function tagsIn(report: unknown): Tally {
  const failed = new Set<string>();
  const seen = new Set<string>();
  let ran = 0;
  let listed = 0;
  const files: unknown = Reflect.get(Object(report), "testResults");
  for (const file of Array.isArray(files) ? files : []) {
    const assertions: unknown = Reflect.get(Object(file), "assertionResults");
    for (const assertion of Array.isArray(assertions) ? assertions : []) {
      const name = String(Reflect.get(Object(assertion), "fullName") ?? "");
      const status = Reflect.get(Object(assertion), "status");
      listed += 1;
      if (status === "passed" || status === "failed") ran += 1;
      for (const [, tag] of name.matchAll(/\[([\w.-]+)\]/g)) {
        if (tag === undefined) continue;
        seen.add(tag);
        if (status === "failed") failed.add(tag);
      }
    }
  }
  return { failed, seen, ran, listed };
}

function excerpt(output: string): string {
  return output
    .split("\n")
    .filter((line) => /×|FAIL|error TS|AssertionError|Error:|Tests |expected/.test(line))
    .slice(0, 6)
    .map((line) => `       ${line.trim()}`)
    .join("\n");
}

/** A result's first line, with the lines of the command's output worth showing under it. */
const withExcerpt = (line: string, output: string): string =>
  excerpt(output) === "" ? line : `${line}\n${excerpt(output)}`;

const bracketed = (tags: readonly string[]): string => tags.map((tag) => `[${tag}]`).join(", ");

/**
 * Why a run with no patch applied leaves a mutant's claims unproven, or null
 * when every claimed tag has a test and none of them failed. A test the mutant
 * does not claim may fail here: it decides nothing about this mutant.
 */
function baselineFault(clean: Ran, kills: readonly string[]): string | null {
  if (clean.report === undefined)
    return withExcerpt(
      `no JSON report without the mutant (exit ${clean.status}); the suite did not run`,
      clean.output,
    );
  const { failed, seen } = tagsIn(clean.report);
  const unseen = kills.filter((tag) => !seen.has(tag));
  if (unseen.length > 0) return `no test carries ${bracketed(unseen)} without the mutant`;
  const red = kills.filter((tag) => failed.has(tag));
  if (red.length > 0)
    return `${bracketed(red)} ${red.length === 1 ? "fails" : "fail"} without the mutant`;
  return null;
}

/**
 * The prover for one run of the script. It keeps each baseline it takes, so
 * the mutants that share a command share one run of it.
 */
export function prover(given: {
  readonly run: (run: Run) => Ran;
  /** Unseeded runs per tagged mutant, after the fixed seeds. */
  readonly unseeded: number;
}): (mutant: Mutant) => Proof {
  const { run, unseeded } = given;
  const baselines = new Map<string, Ran>();

  /** The command with no patch applied, under the first seed: once per command and kind of run. */
  const baseline = (command: string, reported: boolean): Ran => {
    const key = `${reported ? "report" : "exit"} ${command}`;
    const kept = baselines.get(key);
    if (kept !== undefined) return kept;
    const clean = run({ command, seed: SEEDS[0], reported });
    baselines.set(key, clean);
    return clean;
  };

  /** Red only if every claimed tag fails in every run: each fixed seed, then the unseeded runs. */
  const tagged = ({ command, kills, mutated }: Mutant): Proof => {
    const filtered = filteredToClaims(command, kills);
    const fault = baselineFault(baseline(filtered, true), kills);
    if (fault !== null) return { verdict: "baseline-red", note: "", detail: fault };
    return mutated(() => {
      let note = "no tests";
      const runs = [
        ...SEEDS.map((seed) => ({ label: `seed ${seed}`, seed })),
        ...Array.from({ length: unseeded }, (_, i) => ({
          label: `unseeded run ${i + 1}`,
          seed: undefined,
        })),
      ];
      for (const { label, seed } of runs) {
        const ran = run({ command: filtered, seed, reported: true });
        if (ran.report === undefined)
          return {
            verdict: "survived",
            note,
            detail: withExcerpt(
              `${label}: no JSON report (exit ${ran.status}); the suite did not run`,
              ran.output,
            ),
          };
        const tally = tagsIn(ran.report);
        note = `${tally.ran} of ${tally.listed} tests`;
        const unseen = kills.filter((tag) => !tally.seen.has(tag));
        if (unseen.length > 0)
          return {
            verdict: "survived",
            note,
            detail: `${label}: no test carries ${bracketed(unseen)}`,
          };
        const green = kills.filter((tag) => !tally.failed.has(tag));
        if (green.length > 0)
          return {
            verdict: "survived",
            note,
            detail: `${label}: ${bracketed(green)} stayed green`,
          };
      }
      return {
        verdict: "red",
        note,
        detail: `${bracketed(kills)} failed under seeds ${SEEDS.join(", ")} and ${unseeded} unseeded run(s)`,
      };
    });
  };

  /** Red when the command exits non-zero with the patch applied, having exited 0 without it. */
  const untagged = ({ command, mutated }: Mutant): Proof => {
    const clean = baseline(command, false);
    if (clean.status !== 0)
      return {
        verdict: "baseline-red",
        note: "",
        detail: withExcerpt(
          `\`${command}\` exits ${clean.status} without the mutant`,
          clean.output,
        ),
      };
    const ran = mutated(() => run({ command, seed: undefined, reported: false }));
    return ran.status === 0
      ? { verdict: "survived", note: "", detail: `\`${command}\` stayed green` }
      : {
          verdict: "red",
          note: `exit ${ran.status}`,
          detail: withExcerpt(`\`${command}\``, ran.output),
        };
  };

  return (mutant) => (mutant.kills.length > 0 ? tagged(mutant) : untagged(mutant));
}
