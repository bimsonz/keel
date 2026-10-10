import { parseSync } from "oxc-parser";

/** An ESTree node as oxc produces it: a `type`, a `start` offset, and children in its properties. */
export interface AstNode {
  readonly type: string;
  readonly start: number;
  readonly [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

/** Calls `visit` on every node of the file, depth first. */
export function walkAst(file: string, code: string, visit: (node: AstNode) => void): void {
  const { program } = parseSync(file, code, { sourceType: "module" });
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (!isNode(current)) continue;
    visit(current);
    for (const [key, value] of Object.entries(current)) {
      if (key !== "type" && typeof value === "object" && value !== null) stack.push(value);
    }
  }
}

/** The property name of a member expression `a.b`, or null. */
export function memberName(node: AstNode): string | null {
  if (node.type !== "MemberExpression") return null;
  const property = node["property"];
  return isNode(property) && property.type === "Identifier" && typeof property["name"] === "string"
    ? property["name"]
    : null;
}

/** The name of an identifier node, or null. */
export function identifierName(node: unknown): string | null {
  return isNode(node) && node.type === "Identifier" && typeof node["name"] === "string"
    ? node["name"]
    : null;
}

export function child(node: AstNode, key: string): AstNode | null {
  const value = node[key];
  return isNode(value) ? value : null;
}

export function children(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

/** A literal with no expressions in it: a string, number, boolean, null, or a template with no substitutions. */
export function isLiteral(node: AstNode | null): boolean {
  if (node === null) return false;
  if (node.type === "Literal") return true;
  return node.type === "TemplateLiteral" && children(node, "expressions").length === 0;
}

export function lineOf(code: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < code.length; i += 1) if (code.charCodeAt(i) === 10) line += 1;
  return line;
}
