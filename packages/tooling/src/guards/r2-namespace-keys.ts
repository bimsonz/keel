import { type AstNode, child, children, identifierName, lineOf, walkAst } from "../arch/ast.ts";
import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { isGenerated, isTest, scanFiles, sourcesUnder } from "../arch/scan.ts";

export const R2_NAMESPACE_KEYS = "r2-namespace-keys";

const BUILDER = "packages/core/src/application/verification/namespace-keys.ts";
const SOURCE = /^(?:apps|packages)\/[^/]+\/src\//;

/** The families `KeyFamily` names, when `node` declares it: the string literals of its union. */
function familiesOf(node: AstNode): string[] {
  if (node.type !== "TSTypeAliasDeclaration" || identifierName(child(node, "id")) !== "KeyFamily")
    return [];
  const type = child(node, "typeAnnotation");
  const members =
    type?.type === "TSUnionType" ? children(type, "types") : type === null ? [] : [type];
  return members.flatMap((member) => {
    const family = child(member, "literal")?.["value"];
    return typeof family === "string" ? [family] : [];
  });
}

/** What a string literal holds, or a template holds before its first substitution. */
function opening(node: AstNode): string | null {
  if (node.type === "Literal") return typeof node["value"] === "string" ? node["value"] : null;
  if (node.type !== "TemplateLiteral") return null;
  const cooked: unknown = Reflect.get(Object(children(node, "quasis")[0]?.["value"]), "cooked");
  return typeof cooked === "string" ? cooked : null;
}

/**
 * Every object Keel keeps in R2 for a project sits under its namespace, at
 * `ns/<namespaceId>/<family>/<hex>`, and `namespaceKey` is the one place that
 * key is built. A store that spells a key itself can leave the namespace out
 * or name another, so outside namespace-keys.ts no string or template in the
 * apps' and packages' source opens with `ns/`, or with a family and a slash
 * (`bundles/…`, the key of before namespaces). The families are read from
 * `KeyFamily` itself, so a new one is guarded once it is named. A path in a
 * comment is not a key and is not read.
 */
export function checkR2NamespaceKeys(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(
    root,
    sourcesUnder(root, ["apps", "packages"]).filter(
      (p) => SOURCE.test(p) && !isTest(p) && !isGenerated(p),
    ),
  );
  const families: string[] = [];
  for (const file of files)
    if (file.path === BUILDER)
      walkAst(file.path, file.code, (node) => families.push(...familiesOf(node)));
  const prefixes = ["ns", ...families].map((name) => `${name}/`);
  const violations: Violation[] = [];
  let built = 0;
  for (const file of files) {
    walkAst(file.path, file.code, (node) => {
      const text = opening(node);
      const prefix = text === null ? undefined : prefixes.find((p) => text.startsWith(p));
      if (prefix === undefined) return;
      if (file.path === BUILDER) built += 1;
      else
        violations.push({
          rule: R2_NAMESPACE_KEYS,
          file: file.path,
          line: lineOf(file.code, node.start),
          message: `builds a key under ${prefix} by hand; a namespace's key comes only from namespaceKey`,
        });
    });
  }
  if (files.length > 0 && (families.length === 0 || built === 0))
    violations.push({
      rule: R2_NAMESPACE_KEYS,
      file: BUILDER,
      message: `vacuous: ${BUILDER} names no key family or builds no key; was namespaceKey moved?`,
    });
  return withVacuityCheck(
    R2_NAMESPACE_KEYS,
    files.map((f) => f.path),
    violations,
    options.vacuity ?? {
      minFiles: 100,
      canary: "apps/keel/src/adapters/driven/r2/bundle-store.ts",
    },
  );
}
