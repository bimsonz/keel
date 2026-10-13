import { type AstNode, child, children, identifierName, lineOf, walkAst } from "../arch/ast.ts";
import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { isGenerated, isTest, scanFiles, sourcesUnder } from "../arch/scan.ts";

export const READONLY_BUNDLES = "readonly-bundles";

const BINDING = "BUNDLES";
const READS = new Set(["get", "head", "list"]);

/** The one file that may write: the deps box keeps a build's parts and its pointer. */
const WRITER = "apps/keel-verify/src/adapters/driving/do/keel-deps-box.ts";
/** What it may write: keys `namespaceKey` builds for these families, and no other. */
const WRITTEN = new Set(["deps", "deps-parts"]);

/** The property a member expression names, whether `a.b` or `a["b"]`. */
function propertyOf(node: AstNode): string | null {
  if (node.type !== "MemberExpression") return null;
  const property = child(node, "property");
  if (property === null) return null;
  if (node["computed"] !== true) return identifierName(property);
  return property.type === "Literal" && typeof property["value"] === "string"
    ? property["value"]
    : null;
}

/** Whether a `put`'s key is `namespaceKey(…, "deps" | "deps-parts", …)`, written in place so the family can be read. */
function isDepsKey(key: AstNode | undefined): boolean {
  if (key?.type !== "CallExpression" || identifierName(child(key, "callee")) !== "namespaceKey")
    return false;
  const family = children(key, "arguments")[1];
  return (
    family?.type === "Literal" &&
    typeof family["value"] === "string" &&
    WRITTEN.has(family["value"])
  );
}

/**
 * keel-verify only reads candidate bundles. R2 cannot make a binding
 * read-only, so this guard does: every use of `BUNDLES` in keel-verify's code
 * must be `….BUNDLES.get|head|list(…)`. A write (`put`, `delete`, a multipart
 * upload) is a violation, and so is any other use, such as an alias or passing
 * the bucket along, because the guard could not follow the bucket after that.
 *
 * One exception: keel-deps-box.ts may `put`, and only a key that
 * `namespaceKey` builds for a namespace's deps pointer or one of its parts.
 * A `put` in any other file, or of any other key, is a violation, so no
 * bundle, evidence or plan is ever written from here.
 */
export function checkReadonlyBundles(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(
    root,
    sourcesUnder(root, ["apps/keel-verify/src"]).filter((p) => !isTest(p) && !isGenerated(p)),
  );
  const violations: Violation[] = [];
  let reads = 0;
  for (const file of files) {
    const uses: AstNode[] = [];
    const allowed = new Set<number>();
    /** Each `….BUNDLES.put(key, …)` call, by where its `….BUNDLES` starts, with the key it writes. */
    const puts = new Map<number, AstNode | undefined>();
    walkAst(file.path, file.code, (node) => {
      if (propertyOf(node) === BINDING) uses.push(node);
      const object = child(node, "object");
      const method = propertyOf(node);
      if (object !== null && propertyOf(object) === BINDING && method !== null && READS.has(method))
        allowed.add(object.start);
      if (node.type === "CallExpression") {
        const callee = child(node, "callee");
        const bucket = callee === null ? null : child(callee, "object");
        if (
          callee !== null &&
          bucket !== null &&
          propertyOf(callee) === "put" &&
          propertyOf(bucket) === BINDING
        )
          puts.set(bucket.start, children(node, "arguments")[0]);
      }
      if (node.type === "ObjectPattern") {
        for (const property of children(node, "properties")) {
          if (identifierName(child(property, "key")) === BINDING) {
            violations.push({
              rule: READONLY_BUNDLES,
              file: file.path,
              line: lineOf(file.code, property.start),
              message: `${BINDING} is destructured; read it only as ${BINDING}.get|head|list`,
            });
          }
        }
      }
    });
    for (const use of uses) {
      if (allowed.has(use.start)) {
        reads += 1;
        continue;
      }
      if (puts.has(use.start)) {
        if (file.path === WRITER && isDepsKey(puts.get(use.start))) continue;
        violations.push({
          rule: READONLY_BUNDLES,
          file: file.path,
          line: lineOf(file.code, use.start),
          message:
            file.path === WRITER
              ? `${BINDING}.put writes a key that is not namespaceKey(…, "deps" | "deps-parts", …)`
              : `${BINDING}.put outside keel-deps-box.ts: only the deps box writes, and only a build's parts and its pointer`,
        });
        continue;
      }
      violations.push({
        rule: READONLY_BUNDLES,
        file: file.path,
        line: lineOf(file.code, use.start),
        message: `${BINDING} is used for something other than get, head or list`,
      });
    }
  }
  if (files.length > 0 && reads === 0 && violations.length === 0) {
    violations.push({
      rule: READONLY_BUNDLES,
      file: ".",
      message: `vacuous: no ${BINDING} read found; was the binding renamed?`,
    });
  }
  return withVacuityCheck(
    READONLY_BUNDLES,
    files.map((f) => f.path),
    violations,
    options.vacuity ?? {
      minFiles: 5,
      canary: "apps/keel-verify/src/adapters/driving/do/keel-sandbox.ts",
    },
  );
}
