import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type GuardOptions, type GuardResult, type Violation, withVacuityCheck } from "../guard.ts";
import { read } from "../scan.ts";
import { packageOf } from "./imports.ts";
import { isGenerated, isTest, scanFiles, sourcesUnder, type ScannedFile } from "./scan.ts";

/** Every workspace package's source directories: apps, packages, examples and e2e. */
export function workspaceSources(root: string): string[] {
  const dirs: string[] = [];
  for (const group of ["apps", "packages", "examples"]) {
    if (!existsSync(join(root, group))) continue;
    for (const name of readdirSync(join(root, group)))
      dirs.push(`${group}/${name}/src`, `${group}/${name}/test`);
  }
  dirs.push("e2e/src", "e2e/test");
  return dirs;
}

function check(
  rule: string,
  files: readonly ScannedFile[],
  forbidden: (specifier: string, file: string) => string | null,
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const ref of file.imports) {
      const reason = forbidden(ref.specifier, file.path);
      if (reason !== null)
        violations.push({ rule, file: file.path, line: ref.line, message: reason });
    }
  }
  return violations;
}

/** R5: the hexagon, gitcore and syntax never import a framework, a runtime, or an MCP SDK. */
export function checkR5(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(
    root,
    sourcesUnder(root, ["packages/core/src", "packages/gitcore/src", "packages/syntax/src"]),
  );
  const violations = check("R5", files, (specifier) => {
    const pkg = packageOf(specifier);
    const banned =
      pkg === "hono" ||
      pkg === "zod" ||
      pkg === "agents" ||
      specifier.startsWith("cloudflare:") ||
      pkg.startsWith("@cloudflare/") ||
      pkg.startsWith("@modelcontextprotocol/");
    return banned
      ? `imports ${specifier}; core, gitcore and syntax stay free of frameworks and runtimes`
      : null;
  });
  return withVacuityCheck(
    "R5",
    files.map((f) => f.path),
    violations,
    options.vacuity ?? { minFiles: 50, canary: "packages/core/src/application/ports/index.ts" },
  );
}

/** R6: zod is imported only by generated code. */
export function checkR6(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(root, sourcesUnder(root, workspaceSources(root)));
  const violations = check("R6", files, (specifier, file) =>
    packageOf(specifier) === "zod" && !isGenerated(file)
      ? `imports ${specifier}; zod belongs to generated code only`
      : null,
  );
  return withVacuityCheck(
    "R6",
    files.map((f) => f.path),
    violations,
    options.vacuity ?? { minFiles: 80, canary: "apps/keel/src/generated/http/schemas.gen.ts" },
  );
}

const RUNTIME_DOORWAYS = /^apps\/[^/]+\/src\/(adapters\/driving\/(do|workflow)|composition)\//;
/**
 * An example built on Flue keeps Flue's layout: its agents (`src/agents/`)
 * and its route map (`src/app.ts`) read the Worker's bindings too.
 */
const EXAMPLE_DOORWAYS =
  /^examples\/[^/]+\/src\/((adapters\/driving\/(do|workflow)|composition|agents)\/|app\.ts$)/;

/**
 * R7: `cloudflare:workers` is imported only by the DO and Workflow doorways and
 * the composition roots, and in an example also by its agents and `app.ts`.
 */
export function checkR7(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(
    root,
    sourcesUnder(root, workspaceSources(root)).filter((p) => !isTest(p)),
  );
  const violations = check("R7", files, (specifier, file) =>
    specifier !== "cloudflare:workers" || RUNTIME_DOORWAYS.test(file) || EXAMPLE_DOORWAYS.test(file)
      ? null
      : file.startsWith("examples/")
        ? "imports cloudflare:workers outside an example's doorways, composition root, agents or app.ts"
        : "imports cloudflare:workers outside a DO or Workflow doorway or a composition root",
  );
  return withVacuityCheck(
    "R7",
    files.map((f) => f.path),
    violations,
    options.vacuity ?? { minFiles: 80, canary: "apps/keel/src/index.ts" },
  );
}

const PUBLIC_CONSUMERS = [
  "apps/console",
  "examples/swarm",
  "examples/loadgen",
  "packages/cli",
  "e2e",
];
const PUBLIC_PACKAGES = new Set([
  "@keeltown/contracts",
  "@keeltown/sdk",
  "@keeltown/workspace-git",
  "@keeltown/cli",
  "@bimsonz/mfp",
]);

function manifestDependencies(root: string, dir: string): string[] {
  const path = join(root, dir, "package.json");
  if (!existsSync(path)) return [];
  const manifest: unknown = JSON.parse(read(root, `${dir}/package.json`));
  const names: string[] = [];
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps: unknown =
      typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, field) : undefined;
    if (typeof deps === "object" && deps !== null) names.push(...Object.keys(deps));
  }
  return names;
}

/**
 * R9: public consumers (the console, the examples, the CLI, e2e) depend only on
 * Keel's public packages, in their manifests and in their imports.
 */
export function checkR9(root: string, options: GuardOptions = {}): GuardResult {
  const violations: Violation[] = [];
  const scanned: string[] = [];
  for (const dir of PUBLIC_CONSUMERS) {
    if (!existsSync(join(root, dir, "package.json"))) continue;
    scanned.push(`${dir}/package.json`);
    for (const name of manifestDependencies(root, dir)) {
      if (
        (name.startsWith("@keeltown/") || name.startsWith("@bimsonz/")) &&
        !PUBLIC_PACKAGES.has(name)
      ) {
        violations.push({
          rule: "R9",
          file: `${dir}/package.json`,
          message: `a public consumer depends on ${name}`,
        });
      }
    }
    const files = scanFiles(root, sourcesUnder(root, [`${dir}/src`, `${dir}/test`]));
    scanned.push(...files.map((f) => f.path));
    violations.push(
      ...check("R9", files, (specifier) => {
        const pkg = packageOf(specifier);
        return pkg.startsWith("@keeltown/") && !PUBLIC_PACKAGES.has(pkg)
          ? `a public consumer imports ${specifier}`
          : null;
      }),
    );
  }
  return withVacuityCheck(
    "R9",
    scanned,
    violations,
    options.vacuity ?? { minFiles: 5, canary: "apps/console/package.json" },
  );
}

const AGENT_LIBRARIES = [
  /^agents$/,
  /^@modelcontextprotocol\/client$/,
  /^@modelcontextprotocol\/sdk$/,
  /^ai$/,
  /^@ai-sdk\//,
  /^openai$/,
  /^@openai\//,
  /^@anthropic-ai\//,
  /^langchain$/,
  /^@langchain\//,
];

/** R10: Keel's Workers never import an agent runtime, an MCP client, or a model SDK (ADR 0001). */
export function checkR10(root: string, options: GuardOptions = {}): GuardResult {
  const files = scanFiles(root, sourcesUnder(root, ["apps/keel/src", "apps/keel-verify/src"]));
  const violations = check("R10", files, (specifier) =>
    AGENT_LIBRARIES.some((pattern) => pattern.test(packageOf(specifier)))
      ? `imports ${specifier}; Keel is a platform agents use, never an agent runtime`
      : null,
  );
  return withVacuityCheck(
    "R10",
    files.map((f) => f.path),
    violations,
    options.vacuity ?? { minFiles: 15, canary: "apps/keel/src/adapters/driving/mcp/server.ts" },
  );
}
