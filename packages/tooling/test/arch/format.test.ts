import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../src/scan.ts";

const root = repoRoot(import.meta.dirname);
const oxfmt = (...args: string[]) => spawnSync(join(root, "node_modules/.bin/oxfmt"), args, { cwd: root, encoding: "utf8" });

/**
 * `pnpm format:check` (oxfmt) earns trust like every other check: its control
 * is a misformatted file it must report, and the canary proves the root
 * config's ignore list has not swallowed the code it exists to check.
 */
describe("format", () => {
  it("goes red on its control, naming the misformatted file", () => {
    const run = oxfmt("--list-different", "-c", "test/controls/format/.oxfmtrc.json", "test/controls/format/misformatted.ts");
    expect(run.stdout.trim().split("\n")).toEqual(["test/controls/format/misformatted.ts"]);
    expect(run.status).toBe(1);
  });

  it("still checks the code: the canary is not ignored by the root config", () => {
    const run = oxfmt("--check", "apps/keel/src/index.ts");
    expect(run.stderr + run.stdout).not.toMatch(/Expected at least one target/);
    expect(run.status).not.toBe(2);
  });
});
