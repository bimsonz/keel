import type { GuardOptions, GuardResult } from "./guard.ts";
import { checkEventNames, EVENT_NAMES } from "./guards/event-names.ts";
import { checkLintConfig, LINT_CONFIG } from "./guards/lint-config.ts";
import { checkLoaderSpec, LOADER_SPEC } from "./guards/loader-spec.ts";
import { checkModelPins, MODEL_PINS } from "./guards/model-pins.ts";
import { checkPublicScrub, PUBLIC_SCRUB } from "./guards/public-scrub.ts";
import { checkR2NamespaceKeys, R2_NAMESPACE_KEYS } from "./guards/r2-namespace-keys.ts";
import { checkReadonlyBundles, READONLY_BUNDLES } from "./guards/readonly-bundles.ts";
import { checkRunnerCredentials, RUNNER_CREDENTIALS } from "./guards/runner-credentials.ts";
import { checkXstateTestOnly, XSTATE_TEST_ONLY } from "./guards/xstate-test-only.ts";
import { checkR8, checkR11, checkR14 } from "./arch/code-rules.ts";
import { checkR5, checkR6, checkR7, checkR9, checkR10 } from "./arch/imports-rules.ts";
import { checkR1, checkR2, checkR3, checkR4, checkR15 } from "./arch/layers.ts";
import { checkR12, checkR13 } from "./arch/structure.ts";

/**
 * Every guard and rule, by name. Each entry runs against a root directory; the
 * real tree passes the workspace root, a control passes `test/controls/<name>`.
 * Controls run with nothing skipped, since a control is all violation.
 */
export interface RegisteredGuard {
  readonly name: string;
  readonly run: (root: string, options?: GuardOptions) => GuardResult | Promise<GuardResult>;
  /** The control's own canary, relative to test/controls/<name>. */
  readonly controlCanary: string;
}

export const guards: readonly RegisteredGuard[] = [
  { name: REGISTRY_PUBLIC, run: checkRegistryPublic, controlCanary: "pnpm-lock.yaml" },
  { name: PUBLIC_SCRUB, run: checkPublicScrub, controlCanary: "README.md" },
  { name: EVENT_NAMES, run: checkEventNames, controlCanary: "event:ChangeSubmitted" },
  { name: LINT_CONFIG, run: checkLintConfig, controlCanary: ".oxlintrc.json" },
  {
    name: RUNNER_CREDENTIALS,
    run: checkRunnerCredentials,
    controlCanary: "apps/keel/src/adapters/driving/workflow/keel-verify.ts",
  },
  {
    name: READONLY_BUNDLES,
    run: checkReadonlyBundles,
    controlCanary: "apps/keel-verify/src/adapters/driving/do/keel-sandbox.ts",
  },
  {
    name: LOADER_SPEC,
    run: checkLoaderSpec,
    controlCanary: "apps/keel-verify/src/adapters/driving/do/tier1/run-probe.ts",
  },
  { name: MODEL_PINS, run: checkModelPins, controlCanary: "apps/keel/wrangler.jsonc" },
  {
    name: XSTATE_TEST_ONLY,
    run: checkXstateTestOnly,
    controlCanary: "packages/core/src/domain/coordination/change-machine.ts",
  },
  {
    name: R2_NAMESPACE_KEYS,
    run: checkR2NamespaceKeys,
    controlCanary: "apps/keel/src/adapters/driven/r2/bundle-store.ts",
  },
];

/**
 * The architecture rules R1–R15 (docs: AGENTS.md § The hexagon). Each control
 * fixture mirrors the real layout under test/controls/R<n>/ and plants one
 * kind of violation; its canary is the control's own file.
 */
export const rules: readonly RegisteredGuard[] = [
  { name: "R1", run: checkR1, controlCanary: "packages/core/src/domain/kernel/index.ts" },
  { name: "R2", run: checkR2, controlCanary: "packages/core/src/application/ports/index.ts" },
  { name: "R3", run: checkR3, controlCanary: "apps/keel/src/adapters/driving/http/handlers.ts" },
  { name: "R4", run: checkR4, controlCanary: "packages/core/src/domain/coordination/index.ts" },
  { name: "R5", run: checkR5, controlCanary: "packages/core/src/application/ports/index.ts" },
  { name: "R6", run: checkR6, controlCanary: "apps/keel/src/generated/http/schemas.gen.ts" },
  { name: "R7", run: checkR7, controlCanary: "apps/keel/src/index.ts" },
  { name: "R8", run: checkR8, controlCanary: "apps/keel/src/composition/isolate.ts" },
  { name: "R9", run: checkR9, controlCanary: "apps/console/package.json" },
  { name: "R10", run: checkR10, controlCanary: "apps/keel/src/adapters/driving/mcp/server.ts" },
  { name: "R11", run: checkR11, controlCanary: "apps/keel/src/adapters/driving/do/alarm.ts" },
  { name: "R12", run: checkR12, controlCanary: "packages/core/src/domain/kernel" },
  { name: "R13", run: checkR13, controlCanary: "apps/keel/wrangler.jsonc" },
  { name: "R14", run: checkR14, controlCanary: "packages/testing/test/ports.test.ts" },
  { name: "R15", run: checkR15, controlCanary: "apps/keel/src/rpc/exit.ts" },
];

/** Everything `pnpm guards` and `pnpm tooling:controls` run. */
export const allChecks: readonly RegisteredGuard[] = [...guards, ...rules];
