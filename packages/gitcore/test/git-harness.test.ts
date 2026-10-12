// The harness's own rule: every synchronous git child in these tests goes
// through `gitSync`, which kills a child at its timeout and says so. A git
// that hangs (fast-import once sat reading stdin for hours while spawnSync
// waited for it to exit) then fails its case instead of holding a worker.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitSync, GitTimedOut } from "./git-harness.ts";

/** How long the stand-in for a hung git sleeps: far longer than the call may take once killed. */
const HANG_SECONDS = 20;

describe("git harness", () => {
  it(
    "[harness.timeout] kills a git child that outlives its timeout, and says which",
    { timeout: 60_000 },
    () => {
      const started = Date.now();
      let thrown: unknown;
      try {
        gitSync(["-c", `alias.hang=!sleep ${HANG_SECONDS}`, "hang"], { timeoutMs: 200 });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(GitTimedOut);
      expect(String(thrown)).toContain("git hang timed out after 200 ms and was killed");
      // Killed, not waited for: the call is back long before the sleep ends.
      expect(Date.now() - started).toBeLessThan((HANG_SECONDS * 1000) / 2);
    },
  );

  it("[harness.one-door] no test here spawns a process but through the harness", () => {
    const here = import.meta.dirname;
    const spawning = readdirSync(here, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .filter((file) =>
        /["'](node:)?child_process["']/.test(readFileSync(join(here, file), "utf8")),
      )
      .toSorted();
    expect(spawning).toEqual(["git-harness.ts"]);
  });
});
