import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  argumentsOf,
  type Claim,
  claimedPattern,
  filteredToClaims,
  prover,
  type Ran,
  type Run,
  sweeper,
} from "../src/prove-red.ts";

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
const shellWordsOf = (command: string): string[] => {
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
      expect(shellWordsOf(command)).toEqual(["run", "x.test.ts", "-t", claimedPattern(kills)]);
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

/** The title of the test at `index`, carrying `tag`. */
const titleOf = (tag: string, index: number): string =>
  `suite ${index} [${tag}] holds for every input`;

/** The name pattern a command hands vitest with `-t`, as a shell would read it; none runs every test. */
const namePatternOf = (command: string): RegExp => {
  const quoted = /(?:^|\s)-t '((?:[^']|'\\'')*)'/.exec(command)?.[1];
  return new RegExp(quoted === undefined ? "" : quoted.replaceAll("'\\''", "'"));
};

/** Each test of the tree as a run of `command` leaves it: the ones its `-t` leaves out are skipped. */
const statusesOf = (
  tags: readonly string[],
  failing: ReadonlySet<string>,
  command: string,
): { fullName: string; status: "passed" | "failed" | "skipped" }[] => {
  const named = namePatternOf(command);
  return tags.map((tag, index) => {
    const fullName = titleOf(tag, index);
    const ran = failing.has(tag) ? "failed" : "passed";
    return { fullName, status: named.test(fullName) ? ran : "skipped" };
  });
};

/** A prover over a tree, with a log of every run it asked for and a count of the patches it applied. */
const stage = (tree: Tree) => {
  const log: string[] = [];
  let patched = false;
  let applications = 0;
  const run = ({ command, seed, reported }: Run): Ran => {
    log.push(`${patched ? "patched" : "clean"}, seed ${seed ?? "none"}: ${command}`);
    const failing = new Set([...tree.broken, ...(patched ? tree.killed : [])]);
    const assertionResults = statusesOf(tree.tags, failing, command);
    return {
      status: assertionResults.some(({ status }) => status === "failed") ? 1 : 0,
      report: reported && tree.reports ? { testResults: [{ assertionResults }] } : undefined,
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
  return {
    prove: prover({ run, unseeded: 2 }),
    run,
    mutated,
    log,
    applications: () => applications,
  };
};

const COMMAND = "pnpm vitest run --project unit x.test.ts";
/** COMMAND as the runner narrows it for a mutant that claims `a.b`. */
const FILTERED = `${COMMAND} -t '\\[a\\.b\\]'`;
/** A command that names its own tests, so every mutant runs it as written. */
const EXPLICIT = `${COMMAND} -t 'a|c'`;
/** A command whose own `-t` leaves the test carrying `a.b` out. */
const ELSEWHERE = `${COMMAND} -t '\\[c\\.d\\]'`;
/** A command whose own `-t` runs the file's first test alone. */
const FIRST = `${COMMAND} -t 'suite 0 '`;

describe("prove:red's baseline", () => {
  it("[prove-red.baseline] never counts a claimed tag red when it fails with no patch applied, and never applies that patch", () => {
    // The control: a claimed test that passes as the tree stands and fails under the patch is a kill.
    const sound = stage({ tags: ["a.b", "c.d"], broken: [], killed: ["a.b"], reports: true });
    expect(sound.prove({ command: COMMAND, kills: ["a.b"], mutated: sound.mutated })).toEqual({
      verdict: "red",
      note: "1 of 2 tests",
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

describe("prove:red's baseline, when a claimed test did not run", () => {
  it("[prove-red.baseline-ran] never takes a claimed tag whose every test was left out as a green baseline", () => {
    // The header's own -t leaves the claimed test out: it is listed, skipped, and could never fail.
    const idle = stage({ tags: ["a.b", "c.d"], broken: [], killed: ["a.b"], reports: true });
    expect(idle.prove({ command: ELSEWHERE, kills: ["a.b"], mutated: idle.mutated })).toEqual({
      verdict: "baseline-red",
      note: "",
      detail: "no test carrying [a.b] ran without the mutant",
    });
    expect(idle.applications()).toBe(0);
    expect(idle.log).toEqual([`clean, seed 42: ${ELSEWHERE}`]);

    // One test carrying the tag ran and one was left out: that is a baseline, and the kill counts.
    const partly = stage({ tags: ["a.b", "a.b"], broken: [], killed: ["a.b"], reports: true });
    expect(partly.prove({ command: FIRST, kills: ["a.b"], mutated: partly.mutated })).toEqual({
      verdict: "red",
      note: "1 of 2 tests",
      detail: "[a.b] failed under seeds 42, 1337, 20261014 and 2 unseeded run(s)",
    });

    // A sweep asked about a claim it was never told of reads the run it has, which left that test out.
    const stranger = stage({ tags: ["a.b", "c.d"], broken: [], killed: [], reports: true });
    const baselineOf = sweeper({
      run: stranger.run,
      mutants: [{ command: COMMAND, kills: ["a.b"] }],
    });
    expect(baselineOf({ command: COMMAND, kills: ["c.d"] })).toEqual({
      verdict: "baseline-red",
      detail: "no test carrying [c.d] ran without the mutant",
    });
  });
});

/**
 * `--baseline-only` is the sweep: every baseline and no patch, so that the
 * whole of test/mutants can be checked for proofs that would lie. It takes one
 * run for each command as written, narrowed to every tag claimed under it.
 */

/** A tree and a claim on it, with what the sweep must say when it is told of that claim alone. */
const SWEPT: readonly {
  readonly tree: Tree;
  readonly claim: Claim;
  readonly says: ReturnType<ReturnType<typeof sweeper>>;
}[] = [
  {
    tree: { tags: ["a.b", "c.d"], broken: [], killed: ["a.b"], reports: true },
    claim: { command: COMMAND, kills: ["a.b"] },
    says: { verdict: "baseline-green", note: "1 of 2 tests" },
  },
  {
    tree: { tags: ["a.b", "c.d"], broken: ["a.b"], killed: ["a.b"], reports: true },
    claim: { command: COMMAND, kills: ["a.b"] },
    says: { verdict: "baseline-red", detail: "[a.b] fails without the mutant" },
  },
  {
    tree: { tags: ["a.b", "c.d"], broken: ["c.d"], killed: ["a.b"], reports: true },
    claim: { command: EXPLICIT, kills: ["a.b", "c.d"] },
    says: { verdict: "baseline-red", detail: "[c.d] fails without the mutant" },
  },
  {
    tree: { tags: ["c.d"], broken: [], killed: [], reports: true },
    claim: { command: COMMAND, kills: ["a.b"] },
    says: { verdict: "baseline-red", detail: "no test carries [a.b] without the mutant" },
  },
  {
    tree: { tags: ["a.b"], broken: [], killed: ["a.b"], reports: false },
    claim: { command: COMMAND, kills: ["a.b"] },
    says: {
      verdict: "baseline-red",
      detail: "no JSON report without the mutant (exit 0); the suite did not run",
    },
  },
  {
    tree: { tags: ["a.b", "c.d"], broken: [], killed: ["a.b"], reports: true },
    claim: { command: ELSEWHERE, kills: ["a.b"] },
    says: { verdict: "baseline-red", detail: "no test carrying [a.b] ran without the mutant" },
  },
  {
    tree: { tags: ["a.b"], broken: [], killed: ["a.b"], reports: true },
    claim: { command: "pnpm guards", kills: [] },
    says: { verdict: "baseline-green", note: "exit 0" },
  },
  {
    tree: { tags: ["a.b"], broken: ["a.b"], killed: ["a.b"], reports: true },
    claim: { command: "pnpm guards", kills: [] },
    says: { verdict: "baseline-red", detail: "`pnpm guards` exits 1 without the mutant" },
  },
];

describe("prove:red's sweep of baselines", () => {
  it("[prove-red.sweep] says of a mutant what its own proof's baseline says, from that one run with no patch", () => {
    for (const { tree, claim, says } of SWEPT) {
      const swept = stage(tree);
      const reported: boolean[] = [];
      const run = (asked: Run): Ran => {
        reported.push(asked.reported);
        return swept.run(asked);
      };
      expect(sweeper({ run, mutants: [claim] })(claim)).toEqual(says);
      // A tagged claim is read from vitest's report; an untagged one from the exit code, with no report asked for.
      expect(reported).toEqual([claim.kills.length > 0]);

      // The prover on the same tree: red baselines are the same ones, in the same words, and the
      // sweep's one run is the run the proof begins with.
      const proved = stage(tree);
      const proof = proved.prove({ ...claim, mutated: proved.mutated });
      expect(says.verdict === "baseline-red" ? says.detail : "not red").toBe(
        proof.verdict === "baseline-red" ? proof.detail : "not red",
      );
      expect(swept.log).toEqual(proved.log.slice(0, 1));
      expect(swept.log).toHaveLength(1);
    }
  });

  it("[prove-red.sweep-one-run] takes one run for a command, narrowed to every tag claimed under it, and judges each mutant by its own claims", () => {
    const { run, log } = stage({
      tags: ["a.b", "c.d", "e.f"],
      broken: ["c.d"],
      killed: [],
      reports: true,
    });
    const mutants: readonly Claim[] = [
      { command: COMMAND, kills: ["a.b"] },
      { command: COMMAND, kills: ["c.d"] },
      { command: COMMAND, kills: ["c.d", "a.b"] },
      { command: COMMAND, kills: ["a.b"] },
      // A command that names its own tests runs as written, once for all its mutants.
      { command: EXPLICIT, kills: ["a.b"] },
      { command: EXPLICIT, kills: ["c.d"] },
      // The same command read for its exit code is another run: that one has no report.
      { command: COMMAND, kills: [] },
      { command: COMMAND, kills: [] },
    ];
    const baselineOf = sweeper({ run, mutants });

    expect(mutants.map((mutant) => baselineOf(mutant))).toEqual([
      // The sibling's claim fails in the same report and decides nothing here.
      { verdict: "baseline-green", note: "2 of 3 tests" },
      { verdict: "baseline-red", detail: "[c.d] fails without the mutant" },
      { verdict: "baseline-red", detail: "[c.d] fails without the mutant" },
      { verdict: "baseline-green", note: "2 of 3 tests" },
      { verdict: "baseline-green", note: "2 of 3 tests" },
      { verdict: "baseline-red", detail: "[c.d] fails without the mutant" },
      { verdict: "baseline-red", detail: `\`${COMMAND}\` exits 1 without the mutant` },
      { verdict: "baseline-red", detail: `\`${COMMAND}\` exits 1 without the mutant` },
    ]);
    expect(log).toEqual([
      `clean, seed 42: ${COMMAND} -t '\\[a\\.b\\]|\\[c\\.d\\]'`,
      `clean, seed 42: ${EXPLICIT}`,
      `clean, seed 42: ${COMMAND}`,
    ]);

    // Asked again, it runs nothing.
    expect(baselineOf({ command: COMMAND, kills: ["a.b"] }).verdict).toBe("baseline-green");
    expect(log).toHaveLength(3);
  });
});

describe("prove:red's arguments", () => {
  it("[prove-red.arguments] reads --baseline-only wherever it stands, never as the name filter, and refuses an option it does not know", () => {
    const plain = { filter: "", unseeded: 2, dir: undefined, baselineOnly: false };
    expect(argumentsOf([])).toEqual(plain);
    expect(argumentsOf(["domain-"])).toEqual({ ...plain, filter: "domain-" });
    expect(argumentsOf(["--baseline-only"])).toEqual({ ...plain, baselineOnly: true });

    // The flag takes no value: the argument after it is still the filter.
    for (const argv of [
      ["--baseline-only", "domain-"],
      ["domain-", "--baseline-only"],
      ["--", "--baseline-only", "domain-"],
    ])
      expect(argumentsOf(argv)).toEqual({ ...plain, filter: "domain-", baselineOnly: true });

    // An option's value is never the filter.
    expect(argumentsOf(["--unseeded", "5", "--dir", "test/controls/prove-red", "x"])).toEqual({
      filter: "x",
      unseeded: 5,
      dir: "test/controls/prove-red",
      baselineOnly: false,
    });
    expect(argumentsOf(["--dir", "x", "--baseline-only", "--unseeded", "0"])).toEqual({
      filter: "",
      unseeded: 0,
      dir: "x",
      baselineOnly: true,
    });

    // A mistyped flag must not start a full proof.
    expect(argumentsOf(["--baseline-olny"])).toEqual({ refused: "unknown option --baseline-olny" });
    expect(argumentsOf(["domain-", "--baseline"])).toEqual({
      refused: "unknown option --baseline",
    });
    for (const argv of [
      ["--unseeded"],
      ["--unseeded", "two"],
      ["--unseeded", "-1"],
      ["--unseeded", "1.5"],
    ])
      expect(argumentsOf(argv)).toEqual({ refused: "--unseeded takes a whole number of runs" });
    expect(argumentsOf(["--dir"])).toEqual({ refused: "--dir takes a patch directory" });
  });
});
