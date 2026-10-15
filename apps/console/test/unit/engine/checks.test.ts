import { describe, expect, it } from "vitest";
import { checksOf, pillOf, stepResultOf } from "../../../src/engine/checks.ts";

/** Lines as Keel's verdict writes them: one per step's result, then what it found, by step. */
const PASSED = [
  "keel.check: pass (proof, tier 2: a command of the project's own runs in a container) evidence sha256:2657",
];
const FAILED = [
  "keel.test: fail (proof, tier 2: a command of the project's own runs in a container) evidence sha256:a10e",
  "keel.test: failing test packages/core/test/lane.test.ts > forms a batch",
];

describe("a change as a pull request", () => {
  it("[checks.pill] is open until it lands or is closed", () => {
    expect(pillOf("queued")).toBe("open");
    expect(pillOf("bounced")).toBe("open");
    expect(pillOf("parked")).toBe("open");
    expect(pillOf("landed")).toBe("landed");
    expect(pillOf("withdrawn")).toBe("closed");
    expect(pillOf("superseded")).toBe("closed");
  });

  it("[checks.step-result] reads how a step went from the line Keel wrote for it, and from no other step's", () => {
    expect(stepResultOf("keel.check", PASSED)).toBe("pass");
    expect(stepResultOf("keel.test", FAILED)).toBe("fail");
    expect(stepResultOf("keel", PASSED)).toBeUndefined();
    expect(stepResultOf("keel.docs", [...PASSED, ...FAILED])).toBeUndefined();
    expect(stepResultOf("keel.test", ["keel.test: failing test a > b"])).toBeUndefined();
  });

  it("[checks.failed] says the checks failed where a step failed, or the verdict bounced the change", () => {
    const checks = checksOf(
      { state: "bounced" },
      {
        outcome: "bounce",
        plan: {
          steps: [
            { id: "keel.check", lines: PASSED },
            { id: "keel.test", lines: FAILED },
          ],
        },
      },
    );
    expect(checksOf({ state: "bounced" }, { outcome: "bounce" }).state).toBe("failed");
    expect(checks).toEqual({
      state: "failed",
      steps: [
        { id: "keel.check", result: "pass" },
        { id: "keel.test", result: "fail" },
      ],
    });
  });

  it("[checks.passed] says they passed on a verdict to land, and are held on one that parks", () => {
    const plan = { steps: [{ id: "keel.check", lines: PASSED }] };
    expect(checksOf({ state: "landed" }, { outcome: "land", plan }).state).toBe("passed");
    expect(checksOf({ state: "parked" }, { outcome: "park", plan }).state).toBe("held");
  });

  it("[checks.waiting] says they are running or queued from the change's state until a verdict is issued", () => {
    expect(checksOf({ state: "verifying" })).toEqual({ state: "running", steps: [] });
    expect(checksOf({ state: "integrating" }).state).toBe("passed");
    expect(checksOf({ state: "queued" }).state).toBe("queued");
    expect(checksOf({ state: "submitted" }).state).toBe("queued");
    expect(checksOf({ state: "working" }).state).toBe("none");
    expect(checksOf({ state: "withdrawn" }).state).toBe("none");
  });
});
