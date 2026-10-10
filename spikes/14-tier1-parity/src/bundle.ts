import { createWorker, InMemoryFileSystem, installDependencies } from "@cloudflare/worker-bundler";
// oxlint-disable-next-line import/default -- loaded as a Text module; typed by vitest-shim.d.ts
import shimSource from "./child/vitest-shim.js";

// Versions the shim is written against. They are added to the project's
// runtime dependencies so worker-bundler fetches them at bundle time.
const SHIM_DEPS: Record<string, string> = {
  "@vitest/expect": "5.0.3",
  "@vitest/spy": "5.0.3",
  "@vitest/utils": "5.0.3",
  chai: "^6.2.2",
};

export interface BundleRequest {
  key: string;
  files: Record<string, string>;
  /** Explicit test files; default is every *.test.* / *.spec.* file. */
  tests?: string[];
  /** One esbuild bundle (and module graph) per test file, like vitest's isolate:true. */
  isolate?: boolean;
  /** Demonstration only: make this matcher always pass. */
  breakMatcher?: string;
  minify?: boolean;
}

export interface Bundle {
  key: string;
  mainModule: string;
  modules: Record<string, string>;
  tests: string[];
  isolate: boolean;
}

export interface BundleReport {
  key: string;
  tests: string[];
  isolate: boolean;
  installMs: number;
  bundleMs: number;
  totalMs: number;
  bytes: number;
  moduleBytes: Record<string, number>;
  installedPackages: number;
  warnings: string[];
}

const TEST_FILE = /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Date.now() only advances when I/O completes in workerd, and a timer turn does
 * not reliably advance it on the edge. A cache lookup is cheap real I/O.
 */
export async function clock(): Promise<number> {
  await caches.default.match("https://clock.invalid/");
  return Date.now();
}

function bundlePackageJson(files: Record<string, string>): string {
  const pkg = files["package.json"] ? (JSON.parse(files["package.json"]) as Record<string, unknown>) : {};
  const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...SHIM_DEPS };
  return JSON.stringify({ name: "keel-tier1-bundle", private: true, type: "module", dependencies: deps });
}

function fileEntry(file: string, breakMatcher?: string): string {
  return [
    `import { __keel } from "vitest";`,
    breakMatcher ? `__keel.breakMatcher(${JSON.stringify(breakMatcher)});` : "",
    `export function run() {`,
    `  return __keel.runFile(${JSON.stringify(file)}, () => import(${JSON.stringify(`/${file}`)}));`,
    `}`,
  ].join("\n");
}

function allFilesEntry(tests: string[], breakMatcher?: string): string {
  return [
    `import { __keel } from "vitest";`,
    breakMatcher ? `__keel.breakMatcher(${JSON.stringify(breakMatcher)});` : "",
    `const FILES = [`,
    ...tests.map((t) => `  [${JSON.stringify(t)}, () => import(${JSON.stringify(`/${t}`)})],`),
    `];`,
    `export async function run() {`,
    `  const out = [];`,
    `  for (const [file, load] of FILES) {`,
    `    try { out.push(...(await __keel.runFile(file, load))); }`,
    `    catch (e) { out.push({ file, name: "<file load>", status: "fail", error: String(e && e.stack || e) }); }`,
    `  }`,
    `  return out;`,
    `}`,
  ].join("\n");
}

/** The child's main module: dispatches to per-file bundles and returns JSON results. */
function mainModuleSource(mods: Array<{ file: string; mod: string }>): string {
  return [
    `const FILES = [`,
    ...mods.map((m) => `  [${JSON.stringify(m.file)}, () => import(${JSON.stringify(`./${m.mod}`)})],`),
    `];`,
    `// Identifies this isolate instance, so the host can tell a warm hit from a fresh isolate.`,
    `let INSTANCE; // set on first request: random values are not allowed at global scope`,
    `let served = 0;`,
    `export default {`,
    `  async fetch(request) {`,
    `    INSTANCE ??= crypto.randomUUID();`,
    `    served++;`,
    `    const results = [];`,
    `    for (const [file, load] of FILES) {`,
    `      try { results.push(...(await (await load()).run())); }`,
    `      catch (e) { results.push({ file, name: "<file load>", status: "fail", error: String(e && e.stack || e) }); }`,
    `    }`,
    `    return Response.json({ results, instance: INSTANCE, served });`,
    `  },`,
    `};`,
  ].join("\n");
}

export async function buildBundle(req: BundleRequest): Promise<{ bundle: Bundle; report: BundleReport }> {
  const t0 = await clock();
  const tests = (req.tests ?? Object.keys(req.files).filter((f) => TEST_FILE.test(f) && !f.includes("node_modules/"))).toSorted();
  if (tests.length === 0) throw new Error("no test files found");
  const isolate = req.isolate ?? true;

  const fs = new InMemoryFileSystem({
    ...req.files,
    "package.json": bundlePackageJson(req.files),
    "__keel/shim.js": shimSource,
  });
  const install = await installDependencies(fs);
  const t1 = await clock();
  const installedPackages = fs.list("node_modules/").filter((p) => /^node_modules\/(@[^/]+\/)?[^/@]+\/package\.json$/.test(p)).length;

  const virtualModules = { vitest: `export * from "/__keel/shim.js";` };
  const modules: Record<string, string> = {};
  const warnings: string[] = [...(install.warnings ?? [])];
  const mods: Array<{ file: string; mod: string }> = [];

  const groups = isolate ? tests.map((t) => [t]) : [tests];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    const entry = `__keel/entry-${i}.js`;
    fs.write(entry, isolate ? fileEntry(group[0]!, req.breakMatcher) : allFilesEntry(group, req.breakMatcher));
    const out = await createWorker({ files: fs, entryPoint: entry, virtualModules, minify: req.minify ?? false });
    const code = out.modules[out.mainModule];
    if (typeof code !== "string") throw new Error(`unexpected module shape for ${entry}`);
    const mod = `f${i}.js`;
    modules[mod] = code;
    warnings.push(...(out.warnings ?? []));
    mods.push({ file: isolate ? group[0]! : "*", mod });
  }
  modules["main.js"] = mainModuleSource(mods);
  const t2 = await clock();

  const moduleBytes = Object.fromEntries(Object.entries(modules).map(([k, v]) => [k, new TextEncoder().encode(v).length]));
  const bytes = Object.values(moduleBytes).reduce((a, b) => a + b, 0);
  return {
    bundle: { key: req.key, mainModule: "main.js", modules, tests, isolate },
    report: {
      key: req.key,
      tests,
      isolate,
      installMs: t1 - t0,
      bundleMs: t2 - t1,
      totalMs: t2 - t0,
      bytes,
      moduleBytes,
      installedPackages,
      warnings: [...new Set(warnings)].slice(0, 20),
    },
  };
}
