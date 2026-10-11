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

export const LOADER_SPEC = "loader-spec";

const CANARY = "apps/keel-verify/src/adapters/driving/do/tier1/run-probe.ts";

/** `(x)` is `x`: oxc keeps parentheses as nodes. */
const unwrap = (node: AstNode | null): AstNode | null => {
  let current = node;
  while (current?.type === "ParenthesizedExpression") current = child(current, "expression");
  return current;
};

const keyName = (property: AstNode): string | null => {
  const key = child(property, "key");
  if (key?.type === "Literal" && typeof key["value"] === "string") return key["value"];
  return property["computed"] === true ? null : identifierName(key);
};

const isNullLiteral = (node: AstNode | null) =>
  node?.type === "Literal" && node["value"] === null && node["raw"] === "null";

/** `….LOADER`, written plainly or as `…["LOADER"]`. */
const isLoaderMember = (node: AstNode) => {
  if (node.type !== "MemberExpression") return false;
  if (node["computed"] !== true) return memberName(node) === "LOADER";
  const property = child(node, "property");
  return property?.type === "Literal" && property["value"] === "LOADER";
};

/** What is wrong with the worker code a `LOADER.get` call hands over, if anything. */
function specProblems(code: AstNode | undefined): string[] {
  if (code?.type !== "ArrowFunctionExpression")
    return [
      "LOADER.get's worker code is not an arrow returning an object literal, so its outbound and env cannot be read",
    ];
  const spec = unwrap(child(code, "body"));
  if (spec?.type !== "ObjectExpression")
    return [
      "LOADER.get's worker code is not an arrow returning an object literal, so its outbound and env cannot be read",
    ];
  const problems: string[] = [];
  const properties = children(spec, "properties");
  if (properties.some((p) => p.type !== "Property"))
    problems.push(
      "LOADER.get's worker code spreads an object, so its outbound and env cannot be read",
    );
  const byKey = new Map(properties.map((p) => [keyName(p), p] as const));
  const outbound = byKey.get("globalOutbound");
  if (outbound === undefined)
    problems.push(
      "LOADER.get's worker code leaves globalOutbound unset; pass globalOutbound: null",
    );
  else if (!isNullLiteral(unwrap(child(outbound, "value"))))
    problems.push(
      "LOADER.get's worker code sets globalOutbound to something other than the literal null",
    );
  const env = byKey.get("env");
  if (env !== undefined) {
    const value = unwrap(child(env, "value"));
    if (value?.type !== "ObjectExpression" || children(value, "properties").length > 0)
      problems.push("LOADER.get's worker code hands the isolate an env");
  }
  return problems;
}

/**
 * Every Tier 1 isolate is born with no network and no bindings. A Dynamic
 * Worker's `globalOutbound` defaults to the parent's own fetch, and its `env`
 * is whatever the spec passes, so neither may be left to a default or
 * computed: every `LOADER.get(id, code)` hands an arrow returning an object
 * literal with the literal `globalOutbound: null` and no `env` (or `env: {}`).
 * LOADER is used no other way (aliased, destructured, passed on), so no spec
 * can be built where this guard cannot read it.
 */
export function checkLoaderSpec(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(
    root,
    sourcesUnder(root, ["apps", "packages"]).filter((p) => !isTest(p) && !isGenerated(p)),
  );
  const violations: Violation[] = [];
  for (const file of files) {
    const at = (node: AstNode, message: string) =>
      violations.push({
        rule: LOADER_SPEC,
        file: file.path,
        line: lineOf(file.code, node.start),
        message,
      });
    const loaders: AstNode[] = [];
    const sanctioned = new Set<number>();
    let gets = 0;
    walkAst(file.path, file.code, (node) => {
      if (node.type === "Property" && keyName(node) === "LOADER") {
        at(node, "LOADER is destructured or passed on, so a spec can escape this guard");
        return;
      }
      if (isLoaderMember(node)) {
        loaders.push(node);
        return;
      }
      if (node.type !== "CallExpression") return;
      const callee = unwrap(child(node, "callee"));
      if (callee === null || memberName(callee) !== "get") return;
      const target = unwrap(child(callee, "object"));
      if (
        target === null ||
        target.type !== "MemberExpression" ||
        target["computed"] === true ||
        memberName(target) !== "LOADER"
      )
        return;
      sanctioned.add(target.start);
      gets++;
      const args = children(node, "arguments");
      if (args.length !== 2) at(node, "LOADER.get takes an id and its worker code, nothing else");
      for (const problem of specProblems(args[1])) at(node, problem);
    });
    for (const loader of loaders)
      if (!sanctioned.has(loader.start))
        at(
          loader,
          "LOADER is used other than as LOADER.get(id, () => ({…})), so a spec can escape this guard",
        );
    if (file.path === CANARY && gets === 0)
      violations.push({
        rule: LOADER_SPEC,
        file: file.path,
        message: `vacuous: canary ${CANARY} makes no LOADER.get call`,
      });
  }
  return withVacuityCheck(
    LOADER_SPEC,
    files.map((f) => f.path),
    violations,
    options.vacuity ?? { minFiles: 50, canary: CANARY },
  );
}
