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

/**
 * The worker-app pack's typecheck: `tsc --noEmit` over the project, in Tier 2
 * (a compiled toolchain, pinned here because it is not a test suite). Proof:
 * it passes with no diagnostics and fails naming them; anything else abstains.
 */
export const WORKER_APP_TYPECHECK: StepSpec = {
  id: "worker-app.typecheck",
  version: contentHashOf({ pack: "worker-app", step: "typecheck", runner: "tsc-noemit/1" }),
  kind: "deterministic",
  evidenceCeiling: "proof",
  appliesTo: { paths: [], subjects: [] },
  reads: [],
  outcomes: ["pass", "fail", "abstain"],
  mayskip: [],
  overrides: [],
  budget: { usd: 0.01, cpuMs: 300_000, tokens: 0 },
  determinism: "deterministic",
  suite: false,
  tier: 2,
  optional: false,
};

/** Keel's defaults for a Worker app: the suite and the typecheck, side by side. */
export const WORKER_APP_PACK: FlowDefaults = {
  flow: {
    _tag: "par",
    items: [
      { _tag: "step", step: JS_TS_SUITE.id },
      { _tag: "step", step: WORKER_APP_TYPECHECK.id },
    ],
  },
  steps: [JS_TS_SUITE, WORKER_APP_TYPECHECK],
};

/** The defaults detection chose for a project, and why. */
export interface VerifierPack {
  readonly name: "worker-app" | "js-ts";
  readonly reason: string;
  readonly defaults: FlowDefaults;
}

const WRANGLER_CONFIGS = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"] as const;

/** The package's dependency names, or none when the package.json is not JSON. */
const dependencyNames = (packageJson: string): readonly string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return [];
  }
  return ["dependencies", "devDependencies", "peerDependencies"].flatMap((field) => {
    const deps: unknown = Reflect.get(Object(parsed), field);
    return typeof deps === "object" && deps !== null ? Object.keys(deps) : [];
  });
};

/**
 * Chooses a project's verifier pack from its base commit: `rootPaths` are the
 * paths at the tree's root, `packageJson` the root package.json's text.
 * A wrangler config, or wrangler or an @cloudflare package among the
 * dependencies, makes a worker app; any other package is js-ts. With no
 * package at all the js-ts suite still runs: it abstains, so the change parks
 * rather than landing unverified.
 */
export const detectPack = (
  rootPaths: readonly string[],
  packageJson: string | undefined,
): VerifierPack => {
  const config = WRANGLER_CONFIGS.find((name) => rootPaths.includes(name));
  if (config !== undefined)
    return { name: "worker-app", reason: `worker-app: ${config}`, defaults: WORKER_APP_PACK };
  if (packageJson === undefined)
    return { name: "js-ts", reason: "no package.json", defaults: JS_TS_SUITE_PACK };
  const tooling = dependencyNames(packageJson).find(
    (name) => name === "wrangler" || name.startsWith("@cloudflare/"),
  );
  return tooling === undefined
    ? { name: "js-ts", reason: "js-ts: package.json", defaults: JS_TS_SUITE_PACK }
    : {
        name: "worker-app",
        reason: `worker-app: depends on ${tooling}`,
        defaults: WORKER_APP_PACK,
      };
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
