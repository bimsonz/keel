import { type GuardOptions, type GuardResult, withVacuityCheck } from "../guard.ts";
import { walk } from "../scan.ts";

export const LINT_CONFIG = "lint-config";

/**
 * Exactly one `.oxlintrc.json`, at the root. oxlint discovers a nested
 * `.oxlintrc.json` and lints its subtree with it, overriding the root's
 * ignores, which is how throwaway spike code once turned main red. A subtree
 * that lints itself names its config differently and passes it with `-c`.
 */
export function checkLintConfig(root: string, options: GuardOptions = {}): GuardResult {
  const configs = walk(root, {
    keep: (path) => /(^|\/)\.oxlintrc\.json$/.test(path),
    skip: options.skip ?? ["test/controls"],
  });
  const violations = configs
    .filter((path) => path !== ".oxlintrc.json")
    .map((file) => ({
      rule: LINT_CONFIG,
      file,
      message:
        "a nested .oxlintrc.json overrides the root lint for its subtree; rename it and pass it with -c",
    }));
  return withVacuityCheck(
    LINT_CONFIG,
    configs,
    violations,
    options.vacuity ?? { minFiles: 1, canary: ".oxlintrc.json" },
  );
}
