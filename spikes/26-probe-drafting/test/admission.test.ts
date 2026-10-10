import { describe, expect, it } from "vitest";
import { admit, vacuity, wilson, type WorldEvaluation } from "../src/admission.ts";
import { deterministicErrors } from "../src/loop.ts";
import { readRun, type RunResult } from "../src/outcome.ts";

const line = (outcome: string, reason = "r") => JSON.stringify({ outcome, reason });
const run = (outcome: "pass" | "fail" | "n/a"): RunResult => readRun(`obs\n${line(outcome)}\n`, { pass: 0, fail: 1, "n/a": 3 }[outcome]);
const world = (name: string, ...outcomes: Array<"pass" | "fail" | "n/a">): WorldEvaluation => ({ world: name, runs: outcomes.map(run) });
const good = () => [world("base", "n/a", "n/a", "n/a"), world("A", "pass", "pass", "pass"), world("B", "n/a", "n/a", "n/a"), world("AB", "fail", "fail", "fail")];

describe("readRun", () => {
  it("accepts one JSON line that agrees with the exit code", () => {
    expect(readRun(`bob DELETE /x -> 403 (expected 403)\n${line("pass", "ok")}\n`, 0)).toMatchObject({ exit: 0, outcome: "pass", reason: "ok" });
    expect(readRun(`${line("n/a")}\n`, 3)).toMatchObject({ exit: 3, outcome: "n/a" });
  });

  it("is a harness error when the JSON line is missing", () => {
    expect(readRun("just text\n", 0)).toMatchObject({ exit: 2 });
    expect(readRun(undefined, undefined).harnessError).toContain("missing JSON line");
  });

  it("is a harness error when an observation is itself JSON", () => {
    const r = readRun(`{"status":403}\n${line("pass")}\n`, 0);
    expect(r.exit).toBe(2);
    expect(r.harnessError).toContain("expected exactly one JSON line, found 2");
  });

  it("is a harness error when the exit code and the outcome disagree, or keys are wrong", () => {
    expect(readRun(`${line("pass")}\n`, 1).exit).toBe(2);
    expect(readRun(`{"outcome":"pass"}\n`, 0).exit).toBe(2);
    expect(readRun(`{"outcome":"maybe","reason":"x"}\n`, 0).exit).toBe(2);
  });

  it("keeps a runner-reported harness error's text", () => {
    const r = readRun(`${JSON.stringify({ outcome: "fail", reason: "probe harness error: the probe test was skipped" })}\n`, 2);
    expect(r).toMatchObject({ exit: 2, harnessError: "the probe test was skipped" });
  });
});

describe("admit", () => {
  it("admits pass in A, fail in A+B, n/a on base and B, three times each", () => {
    expect(admit(good())).toMatchObject({ admitted: true, failures: [] });
  });

  it("rejects a probe that passes everywhere (vacuous assertion)", () => {
    const a = admit([world("base", "pass", "pass", "pass"), world("A", "pass", "pass", "pass"), world("B", "pass", "pass", "pass"), world("AB", "pass", "pass", "pass")]);
    expect(a.admitted).toBe(false);
    expect(a.failures).toEqual(["n/a-mishandled", "wrong-world-behaviour"]);
  });

  it("rejects a probe that ignores the n/a rule on base and B", () => {
    const evals = good();
    evals[0] = world("base", "fail", "fail", "fail");
    evals[2] = world("B", "fail", "fail", "fail");
    expect(admit(evals)).toMatchObject({ admitted: false, failures: ["n/a-mishandled"] });
  });

  it("rejects a flaky probe even when its majority is right", () => {
    const evals = good();
    evals[1] = world("A", "pass", "fail", "pass");
    expect(admit(evals)).toMatchObject({ admitted: false, failures: ["flaky", "wrong-world-behaviour"] });
  });

  it("rejects fewer than three runs, bundle errors and harness errors", () => {
    const short = good();
    short[1] = world("A", "pass", "pass");
    expect(admit(short).admitted).toBe(false);
    const bundle = good();
    bundle[3] = { world: "AB", bundleError: "x", runs: [] };
    expect(admit(bundle).failures).toEqual(["compile-error"]);
    const harness = good();
    harness[1] = { world: "A", runs: [run("pass"), run("pass"), readRun("nothing\n", 0)] };
    expect(admit(harness).failures).toContain("harness-error");
  });
});

describe("vacuity", () => {
  it("is non-vacuous only when the probe fails every run against mutant A", () => {
    expect(vacuity(world("mutantA", "fail", "fail", "fail")).vacuous).toBe(false);
    expect(vacuity(world("mutantA", "pass", "pass", "pass"))).toMatchObject({ vacuous: true, why: "passes with the revoke step removed" });
    expect(vacuity(world("mutantA", "n/a", "n/a", "n/a")).vacuous).toBe(true);
  });
});

describe("deterministicErrors", () => {
  it("feeds back bundle and harness errors, deduplicated, without world names", () => {
    const evals: WorldEvaluation[] = [
      { world: "base", bundleError: "ERROR: Could not resolve", runs: [] },
      { world: "A", runs: [readRun("x\n", 0), readRun("x\n", 0)] },
      world("AB", "fail", "fail", "fail"),
    ];
    const text = deterministicErrors(evals)!;
    expect(text).toContain("Could not resolve");
    expect(text.match(/missing JSON line/g)).toHaveLength(1);
    expect(text).not.toMatch(/\bbase\b|\bAB\b/);
  });

  it("feeds back nothing for wrong outcomes alone", () => {
    expect(deterministicErrors([world("A", "fail", "fail", "fail"), world("base", "pass", "pass", "pass")])).toBeUndefined();
  });
});

describe("wilson", () => {
  it("gives the 95% interval", () => {
    const [lo, hi] = wilson(8, 10);
    expect(lo).toBeCloseTo(0.49, 2);
    expect(hi).toBeCloseTo(0.943, 2);
  });
});
