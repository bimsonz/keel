import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { type AstNode, child, children, identifierName, isLiteral, lineOf, memberName, walkAst } from "./ast.ts";
import { workspaceSources } from "./imports-rules.ts";
import { isGenerated, isTest, scanFiles, sourcesUnder } from "./scan.ts";

const RUNNERS = new Set(["runPromise", "runSync", "runFork", "runPromiseExit", "runSyncExit", "runCallback"]);
const DRIVING = /^apps\/[^/]+\/src\/adapters\/driving\//;
const COMPOSITION = /^apps\/[^/]+\/src\/composition\//;

/**
 * R8: an Effect runtime is run or built only in a composition root or a
 * driving adapter, and a driving adapter never detaches a fiber, because a
 * fiber forked from a request dies with the response.
 */
export function checkR8(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(root, sourcesUnder(root, workspaceSources(root)).filter((p) => !isTest(p) && !isGenerated(p)));
  const violations: Violation[] = [];
  for (const file of files) {
    const mayRun = DRIVING.test(file.path) || COMPOSITION.test(file.path);
    const driving = DRIVING.test(file.path);
    for (const ref of file.imports) {
      if (ref.specifier === "effect" && ref.names.includes("ManagedRuntime") && !mayRun) {
        violations.push({ rule: "R8", file: file.path, line: ref.line, message: "imports ManagedRuntime outside a composition root or driving adapter" });
      }
    }
    walkAst(file.path, file.code, (node) => {
      const name = memberName(node) ?? (node.type === "Identifier" ? identifierName(node) : null);
      if (name === null) return;
      if (RUNNERS.has(name) && node.type === "MemberExpression" && !mayRun) {
        violations.push({ rule: "R8", file: file.path, line: lineOf(file.code, node.start), message: `runs an effect (${name}) outside a composition root or driving adapter` });
      }
      if ((name === "forkDetach" || name === "runFork") && driving && node.type === "MemberExpression") {
        violations.push({ rule: "R8", file: file.path, line: lineOf(file.code, node.start), message: `a driving adapter detaches a fiber (${name}); it would die with the response` });
      }
    });
  }
  return withVacuityCheck("R8", files.map((f) => f.path), violations, options.vacuity ?? { minFiles: 80, canary: "apps/keel/src/composition/isolate.ts" });
}

const ALARM_HELPER = /^apps\/[^/]+\/src\/adapters\/driving\/do\/alarm\.ts$/;

function propertyNamed(objectExpression: AstNode, key: string): AstNode | null {
  for (const property of children(objectExpression, "properties")) {
    const keyNode = child(property, "key");
    if (identifierName(keyNode) === key) return child(property, "value");
  }
  return null;
}

/**
 * R11: Keel's Workers never poll. No `setInterval`; an alarm is armed only
 * through `scheduleAlarm`, which must name its kind (deadline or debounce) and
 * its reason, and only that helper calls `setAlarm`.
 */
export function checkR11(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(root, sourcesUnder(root, ["apps/keel/src", "apps/keel-verify/src"]).filter((p) => !isTest(p) && !isGenerated(p)));
  const violations: Violation[] = [];
  for (const file of files) {
    walkAst(file.path, file.code, (node) => {
      if (node.type !== "CallExpression") return;
      const callee = child(node, "callee");
      const name = callee === null ? null : (identifierName(callee) ?? memberName(callee));
      const line = lineOf(file.code, node.start);
      if (name === "setInterval") violations.push({ rule: "R11", file: file.path, line, message: "setInterval polls; react to an event or arm a named deadline instead" });
      if (name === "setAlarm" && !ALARM_HELPER.test(file.path)) {
        violations.push({ rule: "R11", file: file.path, line, message: "setAlarm outside adapters/driving/do/alarm.ts; arm alarms through scheduleAlarm" });
      }
      if (name === "scheduleAlarm" && !ALARM_HELPER.test(file.path)) {
        const request = children(node, "arguments").find((a) => a.type === "ObjectExpression") ?? null;
        const kind = request === null ? null : propertyNamed(request, "kind");
        const reason = request === null ? null : propertyNamed(request, "reason");
        const kindValue = kind !== null && kind.type === "Literal" ? kind["value"] : null;
        if ((kindValue !== "deadline" && kindValue !== "debounce") || reason === null) {
          violations.push({ rule: "R11", file: file.path, line, message: "scheduleAlarm must name kind: \"deadline\" | \"debounce\" and a reason" });
        }
      }
    });
  }
  return withVacuityCheck("R11", files.map((f) => f.path), violations, options.vacuity ?? { minFiles: 15, canary: "apps/keel/src/adapters/driving/do/alarm.ts" });
}

const ASSERTIONS = new Set(["toBe", "toEqual", "toStrictEqual"]);

/** R14: no test asserts a literal against a literal, and none is focused with `.only`. */
export function checkR14(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(root, sourcesUnder(root, workspaceSources(root), (p) => /\.test\.tsx?$/.test(p)));
  const violations: Violation[] = [];
  for (const file of files) {
    walkAst(file.path, file.code, (node) => {
      if (node.type === "MemberExpression" && memberName(node) === "only") {
        const object = identifierName(child(node, "object"));
        if (object === "it" || object === "test" || object === "describe") {
          violations.push({ rule: "R14", file: file.path, line: lineOf(file.code, node.start), message: `${object}.only focuses the suite and silently skips the rest` });
        }
      }
      if (node.type !== "CallExpression") return;
      const callee = child(node, "callee");
      if (callee === null || !ASSERTIONS.has(memberName(callee) ?? "")) return;
      const subject = child(callee, "object");
      if (subject === null || subject.type !== "CallExpression" || identifierName(child(subject, "callee")) !== "expect") return;
      const actual = children(subject, "arguments")[0] ?? null;
      const expected = children(node, "arguments")[0] ?? null;
      if (isLiteral(actual) && isLiteral(expected)) {
        violations.push({ rule: "R14", file: file.path, line: lineOf(file.code, node.start), message: "asserts a literal against a literal; it can never fail" });
      }
    });
  }
  return withVacuityCheck("R14", files.map((f) => f.path), violations, options.vacuity ?? { minFiles: 8, canary: "packages/testing/test/ports.test.ts" });
}
