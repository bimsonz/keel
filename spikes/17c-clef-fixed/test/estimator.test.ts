import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CALIBRATED_BYTES_PER_TOKEN, CONTEXT_LIMIT, canonical, estimate, type ClefModel } from "../src/estimator.ts";

// S17's recorded live sweep (read-only): bytes of each request and its true token count.
const sweep = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "17-clef-eval", "results", "truncation.json"), "utf8")) as {
  models: Record<ClefModel, { sweep: { predictedTokens: number; bytes: number }[] }>;
};

describe("estimator (unchanged from S17)", () => {
  it("renders like the reference encoder: sorted keys, compact", () => {
    expect(canonical({ b: 1, a: [true, { d: "x", c: null }] })).toBe('{"a":[true,{"c":null,"d":"x"}],"b":1}');
  });
  it("clef: flags every oversize request in the recorded 50K-80K sweep", () => {
    const cap = CONTEXT_LIMIT.clef;
    const over = sweep.models.clef.sweep.filter((r) => r.predictedTokens > cap);
    expect(over.length).toBeGreaterThan(0);
    for (const r of over) expect(Math.ceil(r.bytes / CALIBRATED_BYTES_PER_TOKEN)).toBeGreaterThanOrEqual(cap);
  });
  it("estimates a small request well under the cap", () => {
    const e = estimate({ state: { hunks: ["x"] }, questions: { q: { type: "noul", instructions: "ok?" } } }, "clef");
    expect(e.oversize).toBe(false);
    expect(e.estimatedTokens).toBeGreaterThan(0);
  });
});
