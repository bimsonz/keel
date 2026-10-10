import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { child, identifierName, lineOf, walkAst } from "../arch/ast.ts";
import { isGenerated, isTest, scanFiles, sourcesUnder } from "../arch/scan.ts";

export const RUNNER_CREDENTIALS = "runner-credentials";

const CREDENTIAL_OPTIONS = new Set(["cloudflareCredentials", "sourceControlCredentials"]);

/**
 * No credential enters a Tier 2 runner. @cloudflare/ci hands a runner a
 * Cloudflare token or a source-control token only when a step asks with
 * `cloudflareCredentials` or `sourceControlCredentials`; Keel never asks, so
 * neither option may be set to anything but a literal `false`.
 */
export function checkRunnerCredentials(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(
    root,
    sourcesUnder(root, ["apps/keel/src", "apps/keel-verify/src"]).filter(
      (p) => !isTest(p) && !isGenerated(p),
    ),
  );
  const violations: Violation[] = [];
  for (const file of files) {
    walkAst(file.path, file.code, (node) => {
      if (node.type !== "Property") return;
      const key = identifierName(child(node, "key"));
      if (key === null || !CREDENTIAL_OPTIONS.has(key)) return;
      const value = child(node, "value");
      if (value?.type === "Literal" && value["value"] === false) return;
      violations.push({
        rule: RUNNER_CREDENTIALS,
        file: file.path,
        line: lineOf(file.code, node.start),
        message: `${key} hands a credential to a runner`,
      });
    });
  }
  return withVacuityCheck(
    RUNNER_CREDENTIALS,
    files.map((f) => f.path),
    violations,
    options.vacuity ?? {
      minFiles: 20,
      canary: "apps/keel/src/adapters/driving/workflow/keel-verify.ts",
    },
  );
}
