// The harness's own rule: every synchronous git child in these tests goes
// through `gitSync`, which kills a child at its timeout and says so. A git
// that hangs (fast-import once sat reading stdin for hours while spawnSync
// waited for it to exit) then fails its case instead of holding a worker.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fastImport, gitSync, GitTimedOut, tempRepo } from "./git-harness.ts";

/** How long the stand-in for a hung git sleeps: far longer than the call may take once killed. */
const HANG_SECONDS = 20;

/** The command line of every git process a trace2 event file saw start. */
const startedIn = (trace: string): string[][] =>
  readFileSync(trace, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line): unknown => JSON.parse(line))
    .flatMap((event) =>
      typeof event === "object" &&
      event !== null &&
      "event" in event &&
      event.event === "start" &&
      "argv" in event &&
      Array.isArray(event.argv)
        ? [event.argv.map(String)]
        : [],
    );

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

  it("[harness.no-background-git] a fetch and a push through the harness start no maintenance, so no git outlives its call", () => {
    const [source, target, sink] = [tempRepo(), tempRepo(), tempRepo()];
    const traces = mkdtempSync(join(tmpdir(), "gitcore-trace-"));
    try {
      fastImport(source.dir, [
        {
          mark: 1,
          ref: "refs/heads/main",
          parents: [],
          tree: new Map([["a.txt", { mode: "100644", data: "a\n" }]]),
          message: "one\n",
        },
      ]);
      const traced = { cwd: target.dir, env: { GIT_TRACE2_EVENT: join(traces, "events.json") } };
      const main = "refs/heads/main:refs/heads/main";
      expect(gitSync(["fetch", "-q", source.dir, main], traced).status).toBe(0);
      expect(gitSync(["push", "-q", sink.dir, main], traced).status).toBe(0);
      const started = startedIn(traced.env.GIT_TRACE2_EVENT);
      // The trace is live: it saw the fetch, and the receive-pack the push started.
      expect(started.filter((argv) => argv.includes("fetch"))).toHaveLength(1);
      expect(
        started.filter((argv) => argv.some((arg) => /(^|[/-])receive-pack$/.test(arg))),
      ).not.toEqual([]);
      // Git's auto-maintenance detaches and repacks after its command has returned, into a directory the test may be removing.
      expect(started.filter((argv) => argv.includes("maintenance") || argv.includes("gc"))).toEqual(
        [],
      );
    } finally {
      for (const repo of [source, target, sink]) repo.cleanup();
      rmSync(traces, { recursive: true, force: true });
    }
  });

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
