import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { claimedPattern, filteredToClaims } from "../src/prove-red.ts";

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
