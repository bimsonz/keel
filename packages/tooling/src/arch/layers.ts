import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { archFileCount, forbidCycles, forbidDependency } from "./archunit.ts";
import { resolveRelative } from "./imports.ts";
import { isTest, scanFiles, sourcesUnder } from "./scan.ts";

const CORE = "packages/core";
const DOMAIN = `${CORE}/src/domain`;
const APPLICATION = `${CORE}/src/application`;
const CORE_TSCONFIG = `${CORE}/tsconfig.json`;
const APPS = ["apps/keel", "apps/keel-verify"] as const;

/** R1's allowlist: what the domain may take from `effect`. */
const DOMAIN_EFFECT_NAMES = new Set(["Schema", "Data", "Brand", "Option", "Result", "Match", "Array", "Order", "Equal", "Predicate", "pipe"]);

const inside = (path: string | null, dir: string): boolean => path !== null && (path === dir || path.startsWith(`${dir}/`));

/** Checks that ArchUnitTS matched as many files as our own scan read, so it cannot pass on nothing. */
async function archSawEverything(rule: string, root: string, tsconfig: string, folder: string, expected: number): Promise<Violation[]> {
  const seen = await archFileCount(root, tsconfig, folder);
  return seen >= expected
    ? []
    : [{ rule, file: tsconfig, message: `vacuous: archunit matched ${seen} file(s) in ${folder}, the scan read ${expected}` }];
}

/** R1: the domain imports only the domain, and only the allowlisted names from `effect`. */
export async function checkR1(root: string, options: GuardOptions = {}): Promise<GuardResult> {
  const files = scanFiles(root, sourcesUnder(root, [DOMAIN]).filter((p) => !isTest(p)));
  const violations: Violation[] = [];
  for (const file of files) {
    for (const ref of file.imports) {
      const resolved = resolveRelative(file.path, ref.specifier);
      if (resolved !== null) {
        if (!inside(resolved, DOMAIN)) violations.push({ rule: "R1", file: file.path, line: ref.line, message: `imports ${ref.specifier}, outside the domain` });
      } else if (ref.specifier !== "effect") {
        violations.push({ rule: "R1", file: file.path, line: ref.line, message: `imports the package ${ref.specifier}; the domain may import only effect` });
      } else {
        for (const name of ref.names.filter((n) => !DOMAIN_EFFECT_NAMES.has(n))) {
          violations.push({ rule: "R1", file: file.path, line: ref.line, message: `imports ${name} from effect; the domain may use only ${[...DOMAIN_EFFECT_NAMES].join(", ")}` });
        }
      }
    }
  }
  if (files.length > 0) {
    violations.push(...(await forbidDependency("R1", root, CORE_TSCONFIG, "src/domain/**", "src/application/**")));
    violations.push(...(await archSawEverything("R1", root, CORE_TSCONFIG, "src/domain/**", files.length)));
  }
  return withVacuityCheck("R1", files.map((f) => f.path), violations, options.vacuity ?? { minFiles: 25, canary: `${DOMAIN}/kernel/index.ts` });
}

/** R2: the application imports only the domain, the application and `effect`. */
export function checkR2(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(root, sourcesUnder(root, [APPLICATION]).filter((p) => !isTest(p)));
  const violations: Violation[] = [];
  for (const file of files) {
    for (const ref of file.imports) {
      const resolved = resolveRelative(file.path, ref.specifier);
      if (resolved !== null ? !(inside(resolved, DOMAIN) || inside(resolved, APPLICATION)) : ref.specifier !== "effect") {
        violations.push({ rule: "R2", file: file.path, line: ref.line, message: `imports ${ref.specifier}; the application may import only the domain, the application and effect` });
      }
    }
  }
  return withVacuityCheck("R2", files.map((f) => f.path), violations, options.vacuity ?? { minFiles: 30, canary: `${APPLICATION}/ports/index.ts` });
}

/** R3: driving adapters never import driven adapters; the two meet only in composition. */
export async function checkR3(root: string, options: GuardOptions = {}): Promise<GuardResult> {
  const violations: Violation[] = [];
  const scanned: string[] = [];
  for (const app of APPS) {
    const driving = `${app}/src/adapters/driving`;
    const driven = `${app}/src/adapters/driven`;
    const files = scanFiles(root, sourcesUnder(root, [driving]).filter((p) => !isTest(p)));
    scanned.push(...files.map((f) => f.path));
    for (const file of files) {
      for (const ref of file.imports) {
        if (inside(resolveRelative(file.path, ref.specifier), driven)) {
          violations.push({ rule: "R3", file: file.path, line: ref.line, message: `a driving adapter imports the driven adapter ${ref.specifier}` });
        }
      }
    }
    if (files.length > 0) {
      violations.push(...(await forbidDependency("R3", root, `${app}/tsconfig.json`, "src/adapters/driving/**", "src/adapters/driven/**")));
      violations.push(...(await archSawEverything("R3", root, `${app}/tsconfig.json`, "src/adapters/driving/**", files.length)));
    }
  }
  return withVacuityCheck("R3", scanned, violations, options.vacuity ?? { minFiles: 6, canary: "apps/keel/src/adapters/driving/http/handlers.ts" });
}

const CONTEXT = /^packages\/core\/src\/(domain|application)\/([^/]+)\//;

/** R4: no import cycles, and one context reaches another only through its index.ts. The kernel is open to all. */
export async function checkR4(root: string, options: GuardOptions = {}): Promise<GuardResult> {
  const files = scanFiles(root, sourcesUnder(root, [`${CORE}/src`]).filter((p) => !isTest(p)));
  const violations: Violation[] = [];
  for (const file of files) {
    const from = CONTEXT.exec(file.path);
    for (const ref of file.imports) {
      const resolved = resolveRelative(file.path, ref.specifier);
      const to = resolved === null ? null : CONTEXT.exec(resolved);
      if (from === null || to === null || resolved === null) continue;
      const sameContext = from[2] === to[2] || to[2] === "kernel" || to[2] === "ports";
      if (!sameContext && !resolved.endsWith("/index.ts")) {
        violations.push({ rule: "R4", file: file.path, line: ref.line, message: `reaches into context ${to[2] ?? "?"} past its index.ts: ${ref.specifier}` });
      }
    }
  }
  if (files.length > 0) violations.push(...(await forbidCycles("R4", root, CORE_TSCONFIG, "src/**")));
  for (const app of APPS) {
    if (sourcesUnder(root, [`${app}/src`]).length > 0) violations.push(...(await forbidCycles("R4", root, `${app}/tsconfig.json`, "src/**")));
  }
  return withVacuityCheck("R4", files.map((f) => f.path), violations, options.vacuity ?? { minFiles: 60, canary: `${DOMAIN}/coordination/index.ts` });
}

/** R15: an rpc contract folder imports only core's domain exports, `effect`, and itself. */
export function checkR15(root: string, options: GuardOptions = {}): GuardResult {
  const violations: Violation[] = [];
  const scanned: string[] = [];
  for (const app of APPS) {
    const rpc = `${app}/src/rpc`;
    const files = scanFiles(root, sourcesUnder(root, [rpc]).filter((p) => !isTest(p)));
    scanned.push(...files.map((f) => f.path));
    for (const file of files) {
      for (const ref of file.imports) {
        const resolved = resolveRelative(file.path, ref.specifier);
        const allowed =
          resolved !== null
            ? inside(resolved, rpc)
            : ref.specifier === "effect" || ref.specifier === "@keeltown/core/kernel" || ref.specifier.startsWith("@keeltown/core/domain/");
        if (!allowed) violations.push({ rule: "R15", file: file.path, line: ref.line, message: `the rpc contract imports ${ref.specifier}; it may import only core domain types and effect` });
      }
    }
  }
  return withVacuityCheck("R15", scanned, violations, options.vacuity ?? { minFiles: 10, canary: "apps/keel/src/rpc/exit.ts" });
}
