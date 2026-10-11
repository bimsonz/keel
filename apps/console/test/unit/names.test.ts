import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The console once had names of its own for its views, borrowed from a factory, a stage, a filing cabinet, a
// post room and a stadium. Its places are now called what Keel calls the things in them: a change, a conflict,
// an escalation, the benchmark, Mission Control. This fails if one of the old names comes back, in a file's
// name or in what a file says, so that the next reader finds one vocabulary and not two.

/** The names that were retired. This file says them, and is the one file not read. */
const RETIRED = ["floor", "theatre", "casefile", "case file", "inbox", "scoreboard"];

/** What is not the console's to rename: the language's own rounding, and Keel's generated names for its operations. */
const NOT_OURS = [/Math\.floor/g, /\bInbox_[A-Za-z]+/g];

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** The console's own folder, wherever the tests are run from. */
const CONSOLE = join(import.meta.dirname, "..", "..");

const read = ["src", "test", "scripts"]
  .flatMap((directory) => files(join(CONSOLE, directory)))
  .filter((path) => /\.(ts|tsx|css)$/.test(path) && !path.endsWith("names.test.ts"))
  .map((path) => path.slice(CONSOLE.length + 1));

describe("the names the console uses", () => {
  it("has read the console's own source, and enough of it to mean something", () => {
    expect(read.length).toBeGreaterThan(60);
    expect(read.some((path) => path.endsWith("MissionGraph.tsx"))).toBe(true);
  });

  it("calls no file by a retired name", () => {
    expect(
      read.filter((path) =>
        RETIRED.some((name) => path.toLowerCase().includes(name.replace(" ", ""))),
      ),
    ).toEqual([]);
  });

  it("uses no retired name in what a file says", () => {
    const found = read.flatMap((path) => {
      const said = NOT_OURS.reduce(
        (text, ours) => text.replaceAll(ours, ""),
        readFileSync(join(CONSOLE, path), "utf8"),
      ).toLowerCase();
      return RETIRED.filter((name) => said.includes(name)).map((name) => `${path}: ${name}`);
    });
    expect(found).toEqual([]);
  });
});
