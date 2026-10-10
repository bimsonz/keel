// Output shaping shared by the edge children and the local Node reference run,
// so "correct" means byte-identical JSON between the two.
import type { Node as TsNode, Tree } from "web-tree-sitter";

export type RuffDiagnostic = { code: string | null; message: string; row: number; column: number };
export type RuffWorkspace = { check(src: string): unknown; format(src: string): string };

export function ruffResult(ws: RuffWorkspace, src: string) {
  const diags = ws.check(src) as Array<{
    code: string | null;
    message: string;
    start_location: { row: number; column: number };
  }>;
  const diagnostics: RuffDiagnostic[] = diags.map((d) => ({
    code: d.code,
    message: d.message,
    row: d.start_location.row,
    column: d.start_location.column,
  }));
  return { diagnostics, formatted: ws.format(src) };
}

export function clangResult(formatted: string) {
  return { formatted };
}

export function hclResult(json: string) {
  return { json: JSON.parse(json) as unknown };
}

export const FUNCTION_TYPES = [
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
];

export function treeSitterResult(tree: Tree) {
  const root: TsNode = tree.rootNode;
  const byType: Record<string, number> = {};
  for (const n of root.descendantsOfType(FUNCTION_TYPES)) {
    if (n) byType[n.type] = (byType[n.type] ?? 0) + 1;
  }
  let named = 0;
  const cursor = tree.walk();
  for (;;) {
    if (cursor.currentNode.isNamed) named++;
    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) {
        cursor.delete();
        return {
          rootType: root.type,
          hasError: root.hasError,
          namedNodes: named,
          functionCount: Object.values(byType).reduce((a, b) => a + b, 0),
          functionsByType: byType,
        };
      }
    }
  }
}
