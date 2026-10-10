import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { workspaceSources } from "../arch/imports-rules.ts";
import { packageOf } from "../arch/imports.ts";
import { isTest, scanFiles, sourcesUnder } from "../arch/scan.ts";

export const XSTATE_TEST_ONLY = "xstate-test-only";

/**
 * xstate is test data's format, never a runtime: the domain machines' charts are
 * XState-format plain data that the conformance tests read. No source file in
 * the workspace imports `xstate` or an `@xstate/*` package, so its timers and
 * untyped errors can never reach a Durable Object.
 */
export function checkXstateTestOnly(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(
    root,
    sourcesUnder(
      root,
      workspaceSources(root).filter((dir) => dir.endsWith("/src")),
    ).filter((p) => !isTest(p)),
  );
  const violations: Violation[] = [];
  for (const file of files) {
    for (const ref of file.imports) {
      const pkg = packageOf(ref.specifier);
      if (pkg === "xstate" || pkg.startsWith("@xstate/"))
        violations.push({
          rule: XSTATE_TEST_ONLY,
          file: file.path,
          line: ref.line,
          message: `imports ${ref.specifier}; xstate is a test-only dependency`,
        });
    }
  }
  return withVacuityCheck(
    XSTATE_TEST_ONLY,
    files.map((f) => f.path),
    violations,
    options.vacuity ?? {
      minFiles: 100,
      canary: "packages/core/src/domain/coordination/change-machine.ts",
    },
  );
}
