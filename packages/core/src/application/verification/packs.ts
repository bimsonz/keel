import { Result } from "effect";
import { CommitSha, contentHashOf } from "../../domain/kernel/index.ts";
import {
  compile,
  type FlowDefaults,
  type FlowPlan,
  type StepSpec,
} from "../../domain/verification/index.ts";

/**
 * The js-ts verifier pack's suite step: the project's own test suite, run in
 * Tier 2 (policy `suiteTier`) on the candidate. Proof, because Keel executes
 * it; it passes, fails or abstains, never anything else.
 */
export const JS_TS_SUITE: StepSpec = {
  id: "js-ts.suite",
  version: contentHashOf({ pack: "js-ts", step: "suite", runner: "vitest-json/1" }),
  kind: "deterministic",
  evidenceCeiling: "proof",
  appliesTo: { paths: [], subjects: [] },
  reads: [],
  outcomes: ["pass", "fail", "abstain"],
  mayskip: [],
  overrides: [],
  budget: { usd: 0.01, cpuMs: 300_000, tokens: 0 },
  determinism: "deterministic",
  suite: true,
  optional: false,
};

/** Keel's js-ts defaults: one step, the suite. */
export const JS_TS_SUITE_PACK: FlowDefaults = {
  flow: { _tag: "step", step: JS_TS_SUITE.id },
  steps: [JS_TS_SUITE],
};

/** The base a static plan claims: none. The L1 plan is not compiled per change. */
const NO_BASE = CommitSha.make("0".repeat(40));

const compiled = compile(
  undefined,
  { baseCommit: NO_BASE, touchedPaths: [], subjects: [], facts: {} },
  JS_TS_SUITE_PACK,
);
if (Result.isFailure(compiled)) {
  throw new Error(`the L1 suite pack does not compile: ${compiled.failure.map(String).join("; ")}`);
}

/**
 * The static plan KeelVerify runs at L1: the js-ts suite on the candidate, in
 * Tier 2. KeelVerify refuses a batch whose planHash is anything else. D2.1
 * replaces it with the union of the batch's compiled Verification Plans.
 */
export const L1_SUITE_PLAN: FlowPlan = compiled.success;
