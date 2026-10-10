import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import {
  type AstNode,
  child,
  children,
  identifierName,
  lineOf,
  memberName,
  walkAst,
} from "../arch/ast.ts";
import { isGenerated, isTest, scanFiles, sourcesUnder } from "../arch/scan.ts";

export const RUNNER_CREDENTIALS = "runner-credentials";

const CREDENTIAL_OPTIONS = ["cloudflareCredentials", "sourceControlCredentials"] as const;
const CREDENTIAL_SET = new Set<string>(CREDENTIAL_OPTIONS);

const isLiteralFalse = (node: AstNode | null) =>
  node?.type === "Literal" && node["value"] === false;

/**
 * No credential enters a Tier 2 runner. @cloudflare/ci hands a runner a
 * Cloudflare token or a source-control token when a step asks with
 * `cloudflareCredentials` or `sourceControlCredentials`, and its defaults are
 * not ours to rely on. So every `….runner({…})` call passes an object literal
 * that sets both options, each to the literal `false`; and wherever else either
 * option appears, it is the literal `false` too.
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
    const at = (node: AstNode, message: string) =>
      violations.push({
        rule: RUNNER_CREDENTIALS,
        file: file.path,
        line: lineOf(file.code, node.start),
        message,
      });
    walkAst(file.path, file.code, (node) => {
      if (node.type === "Property") {
        const key = identifierName(child(node, "key"));
        if (key !== null && CREDENTIAL_SET.has(key) && !isLiteralFalse(child(node, "value")))
          at(node, `${key} hands a credential to a runner`);
        return;
      }
      if (node.type !== "CallExpression") return;
      const callee = child(node, "callee");
      if (callee === null || memberName(callee) !== "runner") return;
      const [runnerOptions] = children(node, "arguments");
      if (runnerOptions?.type !== "ObjectExpression") {
        at(node, "runner options are not an object literal, so their credentials cannot be read");
        return;
      }
      const set = new Set(
        children(runnerOptions, "properties").map((property) =>
          identifierName(child(property, "key")),
        ),
      );
      for (const key of CREDENTIAL_OPTIONS)
        if (!set.has(key)) at(node, `runner call leaves ${key} unset; pass ${key}: false`);
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
