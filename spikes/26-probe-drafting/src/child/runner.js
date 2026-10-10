/* oxlint-disable no-underscore-dangle -- __keel is the harness entry exported by the vitest shim */
// The Tier 1 probe runner: the isolate-side equivalent of forge-lite's
// scenarios/run-probe.mjs. It runs the one probe file and reports exactly one
// outcome as a single JSON line after the probe's observations:
//
//   {"outcome":"pass","reason":"..."}   exit 0
//   {"outcome":"fail","reason":"..."}   exit 1
//   {"outcome":"n/a","reason":"..."}    exit 3
//   harness error                       exit 2, outcome "fail", reason "probe harness error: ..."
//
// Observations are the probe's own `[probe] ...` console lines, printed with
// the prefix stripped, as run-probe.mjs prints them. A probe is n/a only when
// its single test fails with `Error: probe not applicable: <reason>`. A pass
// with no observation, a skipped test, a file that does not load, or a file
// with other than one test is a harness error, so a broken probe never looks
// like a pass. The host checks the JSON line (see src/outcome.ts).
import { __keel } from "vitest";

const PROBE = "probe/probe.test.ts";
const EXIT = { pass: 0, fail: 1, "n/a": 3 };
const HARNESS_ERROR = 2;
const NOT_APPLICABLE = /^Error: probe not applicable: (.+)$/m;
const OBSERVATION = /^\[probe\] (.*)$/;

export default {
  async fetch() {
    const observations = [];
    const logs = [];
    const original = console.log;
    console.log = (...args) => {
      const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      logs.push(line);
      for (const l of line.split("\n")) {
        const m = OBSERVATION.exec(l);
        if (m) observations.push(m[1]);
      }
      original(...args);
    };

    const finish = (outcome, reason, exit = EXIT[outcome], tests = []) => {
      console.log = original;
      const stdout = [...observations, JSON.stringify({ outcome, reason })].join("\n") + "\n";
      return Response.json({ exit, stdout, tests, logs: logs.slice(0, 50) });
    };
    const harnessError = (reason, tests) => finish("fail", `probe harness error: ${reason}`, HARNESS_ERROR, tests);

    let tests;
    try {
      tests = await __keel.runFile(PROBE, () => import("/probe/probe.test.ts"));
    } catch (e) {
      const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return harnessError(`expected exactly one probe test, found 0: ${text.slice(0, 500)}`, []);
    }
    if (tests.length !== 1) return harnessError(`expected exactly one probe test, found ${tests.length}`, tests);

    const [test] = tests;
    const failure = test.error ?? "";
    if (test.status === "pass") {
      if (observations.length === 0) return harnessError("the probe passed without reporting any [probe] observation", tests);
      return finish("pass", observations.at(-1), EXIT.pass, tests);
    }
    if (test.status === "fail") {
      const notApplicable = NOT_APPLICABLE.exec(failure);
      if (notApplicable) return finish("n/a", notApplicable[1], EXIT["n/a"], tests);
      // Name the first step that answered differently from what the premise expects.
      const mismatch = observations.find((line) => {
        const statuses = /-> (\d+)\b.*\(expected (\d+)\)$/.exec(line);
        return statuses !== null && statuses[1] !== statuses[2];
      });
      return finish("fail", mismatch ?? (failure.split("\n")[0] || "the probe failed"), EXIT.fail, tests);
    }
    return harnessError(`the probe test was ${test.status === "skip" ? "skipped" : test.status}`, tests);
  },
};
