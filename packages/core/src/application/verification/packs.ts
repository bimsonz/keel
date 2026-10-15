import { Result } from "effect";
import { DEPLOY_SPEC_PATH, type DeploySpec, parseDeploySpec } from "../../domain/delivery/index.ts";
import { contentHashOf } from "../../domain/kernel/index.ts";
import {
  type FlowDefaults,
  HUMAN_CLASS_STEP,
  type PlanStep,
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

/** The js-ts typecheck's command: the project's own `typecheck` script. */
const JS_TS_TYPECHECK_COMMAND = "pnpm run typecheck";

/**
 * The js-ts pack's typecheck, for a package with a `typecheck` script: the
 * script, run as a command of the project's own in Tier 2 and judged by its
 * exit, so a type error bounces the change even when every test passes.
 */
export const JS_TS_TYPECHECK: StepSpec = {
  id: "js-ts.typecheck",
  version: contentHashOf({
    pack: "js-ts",
    step: "typecheck",
    runner: "command/1",
    command: JS_TS_TYPECHECK_COMMAND,
  }),
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
  optional: false,
  run: { command: JS_TS_TYPECHECK_COMMAND },
};

/** Keel's js-ts defaults for a package with a `typecheck` script: the suite and the script, side by side. */
export const JS_TS_TYPECHECK_PACK: FlowDefaults = {
  flow: {
    _tag: "par",
    items: [
      { _tag: "step", step: JS_TS_SUITE.id },
      { _tag: "step", step: JS_TS_TYPECHECK.id },
    ],
  },
  steps: [JS_TS_SUITE, JS_TS_TYPECHECK],
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

/**
 * The worker-app pack's build: the Worker bundled from its wrangler config's
 * entry, in Tier 2 where the project's dependencies are. Proof: it passes with
 * the bundle Keel will upload, fails when the change's config or code cannot
 * make one, and abstains where Keel cannot carry the config yet.
 */
export const WORKER_APP_BUILD: StepSpec = {
  id: "worker-app.build",
  version: contentHashOf({ pack: "worker-app", step: "build", runner: "keel-build/1" }),
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

/**
 * Uploads the build to the project's connected Cloudflare account as a
 * preview: a version of its Worker that is not deployed. Keel makes the call
 * itself, in Tier 0, so the token never enters a container. With no account
 * connected for the spec's target it annotates, and the change goes on.
 */
export const DEPLOY_PREVIEW: StepSpec = {
  id: "deploy.preview",
  version: contentHashOf({ pack: "worker-app", step: "preview", runner: "cloudflare-version/1" }),
  kind: "deploy",
  evidenceCeiling: "proof",
  appliesTo: { paths: [], subjects: [] },
  reads: [],
  outcomes: ["pass", "fail", "abstain", "annotate"],
  mayskip: [],
  overrides: [],
  budget: { usd: 0, cpuMs: 60_000, tokens: 0 },
  determinism: "nondeterministic",
  suite: false,
  tier: 0,
  optional: false,
};

/** Asks the preview each request the deploy spec's smoke checks name, from Keel, and judges the answers. */
export const DEPLOY_SMOKE: StepSpec = {
  id: "deploy.smoke",
  version: contentHashOf({ pack: "worker-app", step: "smoke", runner: "smoke/1" }),
  kind: "deploy",
  evidenceCeiling: "proof",
  appliesTo: { paths: [], subjects: [] },
  reads: [],
  outcomes: ["pass", "fail", "abstain", "annotate"],
  mayskip: [],
  overrides: [],
  budget: { usd: 0, cpuMs: 120_000, tokens: 0 },
  determinism: "nondeterministic",
  suite: false,
  tier: 0,
  optional: false,
};

/** The steps Keel runs itself, in Tier 0, for a project's deploy spec. */
export const DEPLOY_STEP_IDS: readonly string[] = [DEPLOY_PREVIEW.id, DEPLOY_SMOKE.id];

/**
 * The worker-app pack for a project whose base has a deploy spec: the suite
 * and the typecheck beside the build, then its preview, then the smoke checks
 * against it. Each of the three carries the spec, so the plan's hash covers it.
 */
export const workerAppDeployPack = (deploy: DeploySpec): FlowDefaults => ({
  flow: {
    _tag: "par",
    items: [
      ...(WORKER_APP_PACK.flow._tag === "par"
        ? WORKER_APP_PACK.flow.items
        : [WORKER_APP_PACK.flow]),
      {
        _tag: "seq",
        exitOn: "fail",
        items: [WORKER_APP_BUILD, DEPLOY_PREVIEW, DEPLOY_SMOKE].map((step) => ({
          _tag: "step" as const,
          step: step.id,
        })),
      },
    ],
  },
  steps: [
    ...WORKER_APP_PACK.steps,
    ...[WORKER_APP_BUILD, DEPLOY_PREVIEW, DEPLOY_SMOKE].map((step) => ({ ...step, deploy })),
  ],
});

/** The defaults detection chose for a project, and why. */
export interface VerifierPack {
  readonly name: "worker-app" | "js-ts";
  readonly reason: string;
  readonly defaults: FlowDefaults;
}

const WRANGLER_CONFIGS = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"] as const;

/** The package.json's value, or undefined when it is not JSON. */
const parsePackage = (packageJson: string): unknown => {
  try {
    return JSON.parse(packageJson);
  } catch {
    return undefined;
  }
};

/** The package's dependency names, or none when the package.json is not JSON. */
const dependencyNames = (parsed: unknown): readonly string[] =>
  ["dependencies", "devDependencies", "peerDependencies"].flatMap((field) => {
    const deps: unknown = Reflect.get(Object(parsed), field);
    return typeof deps === "object" && deps !== null ? Object.keys(deps) : [];
  });

/** Whether the package has a `typecheck` script to run: a non-empty string. */
const hasTypecheckScript = (parsed: unknown): boolean => {
  const script: unknown = Reflect.get(Object(Reflect.get(Object(parsed), "scripts")), "typecheck");
  return typeof script === "string" && script.trim() !== "";
};

/**
 * Chooses a project's verifier pack from its base commit: `rootPaths` are the
 * paths at the tree's root, `packageJson` the root package.json's text.
 * A wrangler config, or wrangler or an @cloudflare package among the
 * dependencies, makes a worker app; any other package is js-ts, which runs
 * the package's `typecheck` script beside the suite when it has one. With no
 * package at all the js-ts suite still runs: it fails with what to add (a
 * lockfile, vitest), so the change bounces rather than landing unverified.
 *
 * A deploy spec (`deployJson`, the base's `.keel/deploy.json`) that reads
 * makes a worker app that is built, previewed and smoked. One that does not
 * read adds no deploy steps, saying why in the reason: nothing is previewed,
 * so nothing can be deployed, and the change that mends the spec still lands.
 */
export const detectPack = (
  rootPaths: readonly string[],
  packageJson: string | undefined,
  deployJson?: string,
): VerifierPack => {
  if (deployJson !== undefined) {
    const deploy = parseDeploySpec(deployJson);
    if (Result.isSuccess(deploy))
      return {
        name: "worker-app",
        reason: `worker-app: ${DEPLOY_SPEC_PATH}`,
        defaults: workerAppDeployPack(deploy.success),
      };
    const pack = detectPack(rootPaths, packageJson);
    return { ...pack, reason: `${pack.reason}; no deploy steps: ${deploy.failure.detail}` };
  }
  const config = WRANGLER_CONFIGS.find((name) => rootPaths.includes(name));
  if (config !== undefined)
    return { name: "worker-app", reason: `worker-app: ${config}`, defaults: WORKER_APP_PACK };
  if (packageJson === undefined)
    return { name: "js-ts", reason: "no package.json", defaults: JS_TS_SUITE_PACK };
  const parsed = parsePackage(packageJson);
  const tooling = dependencyNames(parsed).find(
    (name) => name === "wrangler" || name.startsWith("@cloudflare/"),
  );
  if (tooling !== undefined)
    return {
      name: "worker-app",
      reason: `worker-app: depends on ${tooling}`,
      defaults: WORKER_APP_PACK,
    };
  return hasTypecheckScript(parsed)
    ? {
        name: "js-ts",
        reason: "js-ts: package.json, with a typecheck script",
        defaults: JS_TS_TYPECHECK_PACK,
      }
    : { name: "js-ts", reason: "js-ts: package.json", defaults: JS_TS_SUITE_PACK };
};

/** The Tier 2 steps KeelVerify has a runner for, by id. Its runner table is keyed by exactly these. */
export const TIER2_STEP_IDS: readonly string[] = [
  JS_TS_SUITE.id,
  WORKER_APP_TYPECHECK.id,
  WORKER_APP_BUILD.id,
];

/**
 * Whether KeelVerify can run the step on a candidate: a guard step (its
 * pinned probe, on a VerifierDO), a Tier 2 step it has a runner for, or a
 * Tier 2 step carrying a command of the project's own (`run`), or a deploy
 * step Keel runs itself in Tier 0 on the deploy spec it carries, or the
 * human-class gate a change to `.keel/flow` adds: the change parks for a
 * maintainer's ruling when it is queued, and a batch reads the gate as that
 * ruling. Nothing else runs yet: no other human step, and no other Tier 0
 * or Tier 1 step. Precheck refuses a plan holding such a step, so no change
 * parks by design.
 */
export const executable = (step: PlanStep): boolean =>
  step.id === HUMAN_CLASS_STEP ||
  step.guards !== undefined ||
  (step.tier.tier === 2 && (step.run !== undefined || TIER2_STEP_IDS.includes(step.id))) ||
  (step.tier.tier === 0 &&
    step.kind === "deploy" &&
    step.deploy !== undefined &&
    DEPLOY_STEP_IDS.includes(step.id));
