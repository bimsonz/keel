import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { claimedPattern, filteredToClaims, prover, type Ran, type Run } from "../src/prove-red.ts";

/**
 * `scripts/prove-red.ts` runs a mutant's command narrowed to the tests the
 * mutant claims to kill. A filter that is dropped, or that matches more than
 * the claimed titles, only makes a proof slower, and one that matches fewer
 * makes a real kill read as a survivor: neither shows up in a result, so the
 * filter is checked here.
 */

const CLAIMS: readonly (readonly string[])[] = [
  ["lattice.join-commutes"],
  ["a.b"],
  ["x-y_z"],
  ["a.b", "x-y_z"],
  ["lattice.join-commutes", "a.b", "x-y_z"],
];

/** Titles that look like a claim of `tag` and are not one. */
const nearMisses = (tag: string): string[] => [
  `${tag} without its brackets`,
  `[${tag}c] a longer tag`,
  `[x${tag}] a tag it ends`,
  ...(tag.includes(".") ? [`[${tag.replaceAll(".", "X")}] its dot read as any character`] : []),
  "[q] an unclaimed tag",
];

/** What a command's arguments are once a real shell has read them, as the runner spawns it. */
const argumentsOf = (command: string): string[] => {
  const run = spawnSync(command, { shell: true, encoding: "utf8" });
  return run.status === 0 ? run.stdout.split("\n").slice(0, -1) : [`exit ${run.status}`];
};

describe("prove:red's filter to a mutant's claimed tests", () => {
  it("[prove-red.claims-only] matches every title that carries a claimed tag, and no other", () => {
    for (const kills of CLAIMS) {
      const pattern = new RegExp(claimedPattern(kills));
      for (const tag of kills) {
        expect(pattern.test(`a suite [${tag}] holds for every input`)).toBe(true);
        expect(nearMisses(tag).filter((title) => pattern.test(title))).toEqual([]);
      }
    }
  });

  it("[prove-red.filter-reaches-vitest] hands the command's last two arguments to the shell as -t and the pattern", () => {
    for (const kills of [...CLAIMS, ["it's", "a b"]]) {
      const command = filteredToClaims("printf '%s\\n' run x.test.ts", kills);
      expect(argumentsOf(command)).toEqual(["run", "x.test.ts", "-t", claimedPattern(kills)]);
    }
  });

  it("[prove-red.explicit-filter-kept] leaves a command that names its own tests, or claims none, as written", () => {
    const explicit = [
      "pnpm vitest run --project unit x.test.ts -t x",
      'pnpm vitest run --project unit x.test.ts -t "a|b"',
      "pnpm vitest run -t x --project unit x.test.ts",
      "pnpm vitest run --project unit x.test.ts --testNamePattern=x",
      "pnpm vitest run --project unit x.test.ts --testNamePattern x",
      "pnpm vitest run --project unit x.test.ts -t",
    ];
    for (const command of explicit) expect(filteredToClaims(command, ["a.b"])).toBe(command);
    expect(filteredToClaims("pnpm guards", [])).toBe("pnpm guards");

    const unfiltered = [
      "pnpm vitest run --project unit x.test.ts --testTimeout 5",
      "pnpm vitest run --project unit packages/x-t/y.test.ts",
      "pnpm vitest run --project unit-t x.test.ts",
    ];
    for (const command of unfiltered)
      expect(filteredToClaims(command, ["a.b"])).toBe(`${command} -t '\\[a\\.b\\]'`);
  });
});

/**
 * Before a patch is applied, the runner takes a baseline: the patch's command
 * with no patch. A test that fails there fails by itself, so its failing under
 * the patch says nothing about the patch. The console's `[console.no-credential]`
 * failed in workerd with no fault applied, and its mutant counted as red.
 *
 * The prover is driven here with a stand-in for the tree, since the script
 * itself refuses a dirty tree and so cannot run under its own mutants.
 */

/** A tree as the prover meets it. */
interface Tree {
  /** Every tag a test in the file carries. */
  readonly tags: readonly string[];
  /** The tags whose tests fail with no patch applied. */
  readonly broken: readonly string[];
  /** The tags whose tests the patch makes fail. */
  readonly killed: readonly string[];
  /** Whether a run that asks for vitest's report gets one. */
  readonly reports: boolean;
}

/** Vitest's JSON report for a file with one test per tag. */
const reportOf = (tags: readonly string[], failing: ReadonlySet<string>): unknown => ({
  testResults: [
    {
      assertionResults: tags.map((tag) => ({
        fullName: `a suite [${tag}] holds for every input`,
        status: failing.has(tag) ? "failed" : "passed",
      })),
    },
  ],
});

/** A prover over a tree, with a log of every run it asked for and a count of the patches it applied. */
const stage = (tree: Tree) => {
  const log: string[] = [];
  let patched = false;
  let applications = 0;
  const run = ({ command, seed, reported }: Run): Ran => {
    log.push(`${patched ? "patched" : "clean"}, seed ${seed ?? "none"}: ${command}`);
    const failing = new Set([...tree.broken, ...(patched ? tree.killed : [])]);
    return {
      status: failing.size === 0 ? 0 : 1,
      report: reported && tree.reports ? reportOf(tree.tags, failing) : undefined,
      output: "",
    };
  };
  const mutated = <T>(body: () => T): T => {
    applications += 1;
    patched = true;
    try {
      return body();
    } finally {
      patched = false;
    }
  };
  return { prove: prover({ run, unseeded: 2 }), mutated, log, applications: () => applications };
};

const COMMAND = "pnpm vitest run --project unit x.test.ts";
/** COMMAND as the runner narrows it for a mutant that claims `a.b`. */
const FILTERED = `${COMMAND} -t '\\[a\\.b\\]'`;
/** A command that names its own tests, so every mutant runs it as written. */
const EXPLICIT = `${COMMAND} -t 'a|c'`;

describe("prove:red's baseline", () => {
  it("[prove-red.baseline] never counts a claimed tag red when it fails with no patch applied, and never applies that patch", () => {
    // The control: a claimed test that passes as the tree stands and fails under the patch is a kill.
    const sound = stage({ tags: ["a.b", "c.d"], broken: [], killed: ["a.b"], reports: true });
    expect(sound.prove({ command: COMMAND, kills: ["a.b"], mutated: sound.mutated })).toEqual({
      verdict: "red",
      note: "2 of 2 tests",
      detail: "[a.b] failed under seeds 42, 1337, 20261014 and 2 unseeded run(s)",
    });
    expect(sound.log).toEqual([
      `clean, seed 42: ${FILTERED}`,
      `patched, seed 42: ${FILTERED}`,
      `patched, seed 1337: ${FILTERED}`,
      `patched, seed 20261014: ${FILTERED}`,
      `patched, seed none: ${FILTERED}`,
      `patched, seed none: ${FILTERED}`,
    ]);

    // The same claim where the test already fails: the patch would have read as a kill in every run.
    const broken = stage({ tags: ["a.b", "c.d"], broken: ["a.b"], killed: ["a.b"], reports: true });
    expect(broken.prove({ command: COMMAND, kills: ["a.b"], mutated: broken.mutated })).toEqual({
      verdict: "baseline-red",
      note: "",
      detail: "[a.b] fails without the mutant",
    });
    expect(broken.applications()).toBe(0);
    expect(broken.log).toEqual([`clean, seed 42: ${FILTERED}`]);

    // One of two claims failing is enough, and the line names that one.
    const half = stage({ tags: ["a.b", "c.d"], broken: ["c.d"], killed: ["a.b"], reports: true });
    expect(half.prove({ command: EXPLICIT, kills: ["a.b", "c.d"], mutated: half.mutated })).toEqual(
      { verdict: "baseline-red", note: "", detail: "[c.d] fails without the mutant" },
    );
    expect(half.applications()).toBe(0);

    // A claimed tag no test carries proves nothing either.
    const absent = stage({ tags: ["c.d"], broken: [], killed: [], reports: true });
    expect(absent.prove({ command: COMMAND, kills: ["a.b"], mutated: absent.mutated })).toEqual({
      verdict: "baseline-red",
      note: "",
      detail: "no test carries [a.b] without the mutant",
    });
    expect(absent.applications()).toBe(0);

    // Nor does a run that leaves no report: the suite did not run.
    const silent = stage({ tags: ["a.b"], broken: [], killed: ["a.b"], reports: false });
    expect(silent.prove({ command: COMMAND, kills: ["a.b"], mutated: silent.mutated })).toEqual({
      verdict: "baseline-red",
      note: "",
      detail: "no JSON report without the mutant (exit 0); the suite did not run",
    });
    expect(silent.applications()).toBe(0);
  });

  it("[prove-red.baseline-claims-only] judges a mutant as before when only a test it does not claim fails with no patch applied", () => {
    const tree = { tags: ["a.b", "c.d"], broken: ["c.d"], reports: true };

    const kill = stage({ ...tree, killed: ["a.b"] });
    expect(kill.prove({ command: EXPLICIT, kills: ["a.b"], mutated: kill.mutated }).verdict).toBe(
      "red",
    );

    const miss = stage({ ...tree, killed: [] });
    expect(miss.prove({ command: EXPLICIT, kills: ["a.b"], mutated: miss.mutated })).toEqual({
      verdict: "survived",
      note: "2 of 2 tests",
      detail: "seed 42: [a.b] stayed green",
    });
  });

  it("[prove-red.baseline-shared] takes one baseline for the mutants that share a command, and judges each by its own claims", () => {
    const { prove, mutated, log } = stage({
      tags: ["a.b", "c.d"],
      broken: ["c.d"],
      killed: ["a.b"],
      reports: true,
    });
    const baselines = (): string[] => log.filter((line) => line.startsWith("clean"));

    expect(prove({ command: EXPLICIT, kills: ["a.b"], mutated }).verdict).toBe("red");
    expect(prove({ command: EXPLICIT, kills: ["a.b"], mutated }).verdict).toBe("red");
    expect(prove({ command: EXPLICIT, kills: ["c.d"], mutated }).verdict).toBe("baseline-red");
    expect(baselines()).toEqual([`clean, seed 42: ${EXPLICIT}`]);

    // Another command is another baseline.
    expect(prove({ command: COMMAND, kills: ["a.b"], mutated }).verdict).toBe("red");
    expect(baselines()).toEqual([`clean, seed 42: ${EXPLICIT}`, `clean, seed 42: ${FILTERED}`]);

    // So is the same command run for its exit code: that run asks for no report, and a tagged
    // mutant reading it would find none.
    const mixed = stage({ tags: ["a.b"], broken: [], killed: ["a.b"], reports: true });
    expect(mixed.prove({ command: EXPLICIT, kills: [], mutated: mixed.mutated }).verdict).toBe(
      "red",
    );
    expect(mixed.prove({ command: EXPLICIT, kills: ["a.b"], mutated: mixed.mutated }).verdict).toBe(
      "red",
    );
  });

  it("[prove-red.baseline-untagged] holds an untagged mutant to a command that exits 0 with no patch applied", () => {
    const guard = "pnpm guards";

    const sound = stage({ tags: ["a.b"], broken: [], killed: ["a.b"], reports: true });
    expect(sound.prove({ command: guard, kills: [], mutated: sound.mutated })).toEqual({
      verdict: "red",
      note: "exit 1",
      detail: "`pnpm guards`",
    });
    expect(sound.log).toEqual([`clean, seed 42: ${guard}`, `patched, seed none: ${guard}`]);

    const inert = stage({ tags: ["a.b"], broken: [], killed: [], reports: true });
    expect(inert.prove({ command: guard, kills: [], mutated: inert.mutated })).toEqual({
      verdict: "survived",
      note: "",
      detail: "`pnpm guards` stayed green",
    });

    const broken = stage({ tags: ["a.b"], broken: ["a.b"], killed: ["a.b"], reports: true });
    expect(broken.prove({ command: guard, kills: [], mutated: broken.mutated })).toEqual({
      verdict: "baseline-red",
      note: "",
      detail: "`pnpm guards` exits 1 without the mutant",
    });
    expect(broken.applications()).toBe(0);
  });
});
