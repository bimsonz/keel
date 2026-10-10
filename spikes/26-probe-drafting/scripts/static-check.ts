// Static vacuity flag: does every DELETE the probe sends have its outcome
// asserted by an `expect`? A DELETE site is a call whose arguments carry the
// string "DELETE" (for example `call("DELETE", path)` or
// `app.request(path, { method: "DELETE" })`), or a call to a local helper whose
// body sends one. Its outcome is asserted when the call sits inside an
// `expect(...)` argument, or when the variable it is bound to is referenced
// inside one. This is a flag, not a gate: the mutant-A run is the gate.
import ts from "typescript";

export interface StaticCheck {
  deleteSites: Array<{ line: number; text: string; boundTo?: string; asserted: boolean }>;
  unasserted: Array<{ line: number; text: string }>;
  expectCalls: number;
}

const isFunctionLike = (n: ts.Node) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);

function carriesDelete(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === "DELETE") found = true;
    else if (!isFunctionLike(n)) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function containsDeleteCall(body: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && n.arguments.some(carriesDelete)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

function isExpectCall(n: ts.Node): boolean {
  return ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "expect";
}

const within = (node: ts.Node, roots: ts.Node[]) => roots.some((r) => node.pos >= r.pos && node.end <= r.end);
/** Is `name` referenced inside one of `roots` that lies within [from, to)? */
const referencedIn = (name: string, roots: ts.Node[], from = 0, to = Number.POSITIVE_INFINITY) => {
  let hit = false;
  for (const r of roots) {
    if (r.pos < from || r.end > to) continue;
    const v = (n: ts.Node) => {
      if (hit) return;
      if (ts.isIdentifier(n) && n.text === name) hit = true;
      else ts.forEachChild(n, v);
    };
    v(r);
  }
  return hit;
};

/** Start positions of every declaration of, or assignment to, `name`. */
function bindingsOf(sf: ts.SourceFile, name: string): number[] {
  const at: number[] = [];
  const v = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) at.push(n.pos);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && n.left.text === name) at.push(n.pos);
    ts.forEachChild(n, v);
  };
  v(sf);
  return at.toSorted((a, b) => a - b);
}

export function staticCheck(source: string): StaticCheck {
  const sf = ts.createSourceFile("probe.test.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  // Local helpers whose own body sends a DELETE: calls to them are DELETE sites too.
  const deleteHelpers = new Set<string>();
  const findHelpers = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isFunctionLike(n.initializer)) {
      const fn = n.initializer as ts.ArrowFunction;
      if (fn.body && containsDeleteCall(fn.body)) deleteHelpers.add(n.name.text);
    }
    if (ts.isFunctionDeclaration(n) && n.name && n.body && containsDeleteCall(n.body)) deleteHelpers.add(n.name.text);
    ts.forEachChild(n, findHelpers);
  };
  findHelpers(sf);

  const expectArgs: ts.Node[] = [];
  const sites: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (isExpectCall(n)) expectArgs.push(...(n as ts.CallExpression).arguments);
    if (ts.isCallExpression(n) && !isExpectCall(n)) {
      // Observation helpers (console.*, log/report/observe/print) carry "DELETE" as text, not as a request.
      const callee = n.expression.getText(sf);
      const logging = /^console\.|(^|\.)(log|report|observe|print)\w*$/i.test(callee);
      const direct = !logging && n.arguments.some(carriesDelete);
      const viaHelper = ts.isIdentifier(n.expression) && deleteHelpers.has(n.expression.text);
      // A DELETE inside a helper's own body is counted at the helper's call sites.
      let inHelper = false;
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (isFunctionLike(p)) {
          const decl = p.parent;
          if (decl && ((ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && deleteHelpers.has(decl.name.text)) || (ts.isFunctionDeclaration(p) && p.name && deleteHelpers.has(p.name.text)))) inHelper = true;
          break;
        }
      }
      if ((direct || viaHelper) && !inHelper) sites.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  const deleteSites = sites.map((site) => {
    let p: ts.Node = site;
    while (p.parent && (ts.isAwaitExpression(p.parent) || ts.isParenthesizedExpression(p.parent))) p = p.parent;
    const parent = p.parent;
    const boundTo =
      parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
        ? parent.name.text
        : parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(parent.left)
          ? parent.left.text
          : undefined;
    // The response must be asserted after the request and before the variable is rebound.
    const nextBinding = boundTo === undefined ? undefined : bindingsOf(sf, boundTo).find((pos) => pos > site.end);
    const asserted = within(site, expectArgs) || (boundTo !== undefined && referencedIn(boundTo, expectArgs, site.end, nextBinding));
    const line = sf.getLineAndCharacterOfPosition(site.getStart()).line + 1;
    return { line, text: site.getText().slice(0, 100), ...(boundTo ? { boundTo } : {}), asserted };
  });
  return {
    deleteSites,
    unasserted: deleteSites.filter((s) => !s.asserted).map(({ line, text }) => ({ line, text })),
    expectCalls: expectArgs.length,
  };
}
