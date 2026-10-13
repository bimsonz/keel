// How `scripts/prove-red.ts` decides whether a mutant went red: what it adds to
// the mutant's command so that it runs only the tests the mutant claims to
// kill, the baseline it takes before the patch is applied, the rule for red,
// which mutants one patched run is enough for, the sweep that takes the
// baselines alone, and how the script's arguments are read. Pure: the script
// does the running and the patching, and hands both in.

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

/**
 * Whether a command runs in pool projects alone: it names at least one
 * `--project`, and every one it names begins `pool:`. A command that names a
 * Node project beside a pool one does not: its Node tests may draw from the
 * seed, so each seed is another run of them.
 */
export function poolAlone(command: string): boolean {
  const named = [...command.matchAll(/--project(?:=|\s+)(?:'([^']*)'|"([^"]*)"|(\S+))/g)].map(
    ([, single, double, bare]) => single ?? double ?? bare ?? "",
  );
  return named.length > 0 && named.every((project) => project.startsWith("pool:"));
}

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
  /**
   * The header's `# all-seeds`: the claimed tests draw from the seed although
   * they run in a pool project, so one run is never the whole proof.
   */
  readonly allSeeds?: boolean;
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
  /** The tags with a test that ran: a test a name filter left out, or a skipped one, is seen only. */
  readonly tested: Set<string>;
  /** Tests that ran, of the tests the report lists: a name filter leaves the rest skipped. */
  readonly ran: number;
  readonly listed: number;
}

/** Each `[tag]` in a test's full name, with whether that test failed, and how many tests ran. */
function tagsIn(report: unknown): Tally {
  const failed = new Set<string>();
  const seen = new Set<string>();
  const tested = new Set<string>();
  let ran = 0;
  let listed = 0;
  const files: unknown = Reflect.get(Object(report), "testResults");
  for (const file of Array.isArray(files) ? files : []) {
    const assertions: unknown = Reflect.get(Object(file), "assertionResults");
    for (const assertion of Array.isArray(assertions) ? assertions : []) {
      const name = String(Reflect.get(Object(assertion), "fullName") ?? "");
      const status = Reflect.get(Object(assertion), "status");
      const didRun = status === "passed" || status === "failed";
      listed += 1;
      if (didRun) ran += 1;
      for (const [, tag] of name.matchAll(/\[([\w.-]+)\]/g)) {
        if (tag === undefined) continue;
        seen.add(tag);
        if (didRun) tested.add(tag);
        if (status === "failed") failed.add(tag);
      }
    }
  }
  return { failed, seen, tested, ran, listed };
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
 * when every claimed tag has a test that ran and none of them failed. A test
 * the mutant does not claim may fail here: it decides nothing about this
 * mutant. A claimed tag whose tests were all left out (by a header's own `-t`,
 * or skipped in the file) can never fail, so it is no baseline either.
 */
function baselineFault(clean: Ran, kills: readonly string[]): string | null {
  if (clean.report === undefined)
    return withExcerpt(
      `no JSON report without the mutant (exit ${clean.status}); the suite did not run`,
      clean.output,
    );
  const { failed, seen, tested } = tagsIn(clean.report);
  const unseen = kills.filter((tag) => !seen.has(tag));
  if (unseen.length > 0) return `no test carries ${bracketed(unseen)} without the mutant`;
  const idle = kills.filter((tag) => !tested.has(tag));
  if (idle.length > 0) return `no test carrying ${bracketed(idle)} ran without the mutant`;
  const red = kills.filter((tag) => failed.has(tag));
  if (red.length > 0)
    return `${bracketed(red)} ${red.length === 1 ? "fails" : "fail"} without the mutant`;
  return null;
}

/** Why an untagged mutant's command proves nothing: it already exits non-zero with no patch applied. */
function exitFault(clean: Ran, command: string): string | null {
  return clean.status === 0
    ? null
    : withExcerpt(`\`${command}\` exits ${clean.status} without the mutant`, clean.output);
}

/**
 * Takes baselines: a command with no patch applied, under the first seed. Each
 * is kept, so a command is run once for its report and once for its exit code,
 * however many mutants ask.
 */
function baselineTaker(run: (run: Run) => Ran): (command: string, reported: boolean) => Ran {
  const baselines = new Map<string, Ran>();
  return (command, reported) => {
    const key = `${reported ? "report" : "exit"} ${command}`;
    const kept = baselines.get(key);
    if (kept !== undefined) return kept;
    const clean = run({ command, seed: SEEDS[0], reported });
    baselines.set(key, clean);
    return clean;
  };
}

/**
 * The prover for one run of the script. It keeps each baseline it takes, so
 * the mutants that share a command share one run of it.
 */
export function prover(given: {
  readonly run: (run: Run) => Ran;
  /** Unseeded runs per tagged mutant, after the fixed seeds. */
  readonly unseeded: number;
  /**
   * `--all-seeds`: every tagged mutant takes every run. Without it, one whose
   * command runs in pool projects alone takes one patched run, under the first
   * seed: almost no pool test draws, so each further run of one would be a
   * copy, and the one that does says so in its header.
   */
  readonly allSeeds: boolean;
}): (mutant: Mutant) => Proof {
  const { run, unseeded, allSeeds } = given;
  const baseline = baselineTaker(run);

  /**
   * Red only if every claimed tag fails in every run: each fixed seed, then
   * the unseeded runs, or the first seed alone for a pool mutant run once.
   */
  const tagged = (mutant: Mutant): Proof => {
    const { command, kills, mutated } = mutant;
    const filtered = filteredToClaims(command, kills);
    const fault = baselineFault(baseline(filtered, true), kills);
    if (fault !== null) return { verdict: "baseline-red", note: "", detail: fault };
    const once = !allSeeds && mutant.allSeeds !== true && poolAlone(command);
    return mutated(() => {
      let note = "no tests";
      const every = [
        ...SEEDS.map((seed) => ({ label: `seed ${seed}`, seed })),
        ...Array.from({ length: unseeded }, (_, i) => ({
          label: `unseeded run ${i + 1}`,
          seed: undefined,
        })),
      ];
      for (const { label, seed } of once ? every.slice(0, 1) : every) {
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
        detail: once
          ? `${bracketed(kills)} failed under seed ${SEEDS[0]}, run once (a pool project)`
          : `${bracketed(kills)} failed under seeds ${SEEDS.join(", ")} and ${unseeded} unseeded run(s)`,
      };
    });
  };

  /** Red when the command exits non-zero with the patch applied, having exited 0 without it. */
  const untagged = ({ command, mutated }: Mutant): Proof => {
    const fault = exitFault(baseline(command, false), command);
    if (fault !== null) return { verdict: "baseline-red", note: "", detail: fault };
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

/** What a sweep is asked about a mutant: its command and its claims. There is no patch to apply. */
export type Claim = Pick<Mutant, "command" | "kills">;

/** What a sweep says of a mutant's baseline. Green proves nothing about the mutant: it was never applied. */
export type Baseline =
  | {
      readonly verdict: "baseline-green";
      /** What the line adds: `2 of 15 tests`, or `exit 0` for an untagged mutant. */
      readonly note: string;
    }
  | {
      readonly verdict: "baseline-red";
      /** The prover's own words for it. */
      readonly detail: string;
    };

/**
 * The sweep: every baseline and no patch. It takes one run for each command as
 * written, narrowed to every tag the given mutants claim under that command,
 * and reads each mutant's own claims from that one report; an untagged
 * mutant's command is run for its exit code. So a few hundred runs judge every
 * patch, where the prover's baselines, one for each set of claims, are twice
 * as many.
 *
 * It is a screen, and the prover is the judge: a test that fails only beside
 * the other claimed tests of its file, or passes only beside them, reads
 * differently here than in that mutant's own proof.
 */
export function sweeper(given: {
  readonly run: (run: Run) => Ran;
  /** Every mutant the sweep will be asked about. */
  readonly mutants: readonly Claim[];
}): (claim: Claim) => Baseline {
  const baseline = baselineTaker(given.run);
  /** The tags claimed under each command as written, in the order first claimed. */
  const claimed = new Map<string, readonly string[]>();
  for (const { command, kills } of given.mutants)
    claimed.set(command, [...new Set([...(claimed.get(command) ?? []), ...kills])]);

  return ({ command, kills }) => {
    if (kills.length === 0) {
      const fault = exitFault(baseline(command, false), command);
      return fault === null
        ? { verdict: "baseline-green", note: "exit 0" }
        : { verdict: "baseline-red", detail: fault };
    }
    const clean = baseline(filteredToClaims(command, claimed.get(command) ?? kills), true);
    const fault = baselineFault(clean, kills);
    if (fault !== null) return { verdict: "baseline-red", detail: fault };
    const { ran, listed } = tagsIn(clean.report);
    return { verdict: "baseline-green", note: `${ran} of ${listed} tests` };
  };
}

/** What a run of the script was asked for. */
export interface Asked {
  /** Only the patches whose file name contains this. Empty for all of them. */
  readonly filter: string;
  /** Unseeded runs per tagged mutant, after the fixed seeds. */
  readonly unseeded: number;
  /** The patch directory, when it is not the default. */
  readonly dir: string | undefined;
  /** Take each baseline and apply nothing. */
  readonly baselineOnly: boolean;
  /** Give every tagged patch every run, also one whose command names pool projects alone. */
  readonly allSeeds: boolean;
}

/**
 * The script's arguments, read. An option it does not know is refused: a
 * mistyped `--baseline-only` would otherwise start a full proof, which applies
 * every patch.
 */
export function argumentsOf(argv: readonly string[]): Asked | { readonly refused: string } {
  let filter: string | undefined;
  let unseeded = 2;
  let dir: string | undefined;
  let baselineOnly = false;
  let allSeeds = false;
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? "";
    if (arg === "--") continue;
    if (arg === "--baseline-only") baselineOnly = true;
    else if (arg === "--all-seeds") allSeeds = true;
    else if (arg === "--unseeded") {
      at += 1;
      unseeded = Number(argv[at] ?? "none");
      if (!Number.isInteger(unseeded) || unseeded < 0)
        return { refused: "--unseeded takes a whole number of runs" };
    } else if (arg === "--dir") {
      at += 1;
      dir = argv[at];
      if (dir === undefined) return { refused: "--dir takes a patch directory" };
    } else if (arg.startsWith("--")) return { refused: `unknown option ${arg}` };
    else filter ??= arg;
  }
  return { filter: filter ?? "", unseeded, dir, baselineOnly, allSeeds };
}
