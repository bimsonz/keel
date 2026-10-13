import { type BundleFile, sha256Hex } from "../bundle.ts";

/** Where every probe lives in the tree it runs against; a probe can add files here and nowhere else. */
export const PROBE_ROOT = ".keel/";

/** The candidate's own guards. A run never sees them: a guard runs the probe its plan pins. */
export const GUARDS_ROOT = ".keel/guards/";

/** The isolate's entry, written beside the world's files. */
export const PROBE_ENTRY = "__keel_probe_entry.js";

/** The lockfile a world's deps bundle is keyed by: the one a deps box installs from. */
export const LOCKFILE = "pnpm-lock.yaml";

const PROBE_TEST = /\.test\.[cm]?[jt]s$/;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Why a probe cannot be laid over a world. */
export class MountRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`probe mount refused: ${reason}`);
    this.name = "MountRefused";
    this.reason = reason;
  }
}

/** The files worker-bundler is given (text only), and the entry it starts from. */
export interface ProbeWorker {
  readonly files: Readonly<Record<string, string>>;
  readonly entry: string;
  /** The probe's one test file. */
  readonly probe: string;
}

/** What a world needs from a deps bundle: nothing, the one keyed by its lockfile, or one it cannot name. */
export type DepsNeed =
  | { readonly _tag: "none" }
  | { readonly _tag: "lockfile"; readonly sha256: string }
  | { readonly _tag: "unkeyed"; readonly reason: string };

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** A file's text, or undefined for bytes that are not UTF-8: worker-bundler bundles text only. */
const textOf = (file: BundleFile): string | undefined => {
  try {
    return utf8.decode(file.bytes);
  } catch {
    return undefined;
  }
};

const inNodeModules = (path: string): boolean => `/${path}`.includes("/node_modules/");

const declaredDependencies = (packageJson: BundleFile | undefined): number => {
  if (packageJson === undefined) return 0;
  const text = textOf(packageJson);
  if (text === undefined) return 0;
  try {
    const dependencies: unknown = Reflect.get(Object(JSON.parse(text)), "dependencies");
    return dependencies !== null && typeof dependencies === "object"
      ? Object.keys(dependencies).length
      : 0;
  } catch {
    return 0;
  }
};

/**
 * Whether a world needs a deps bundle: only when its package.json declares
 * runtime dependencies, and then only the one its pnpm lockfile's sha256 names.
 */
export const depsNeed = async (world: readonly BundleFile[]): Promise<DepsNeed> => {
  const byPath = new Map(world.map((file) => [file.path, file]));
  if (declaredDependencies(byPath.get("package.json")) === 0) return { _tag: "none" };
  const lockfile = byPath.get(LOCKFILE);
  if (lockfile === undefined)
    return { _tag: "unkeyed", reason: `dependencies declared with no ${LOCKFILE}` };
  return { _tag: "lockfile", sha256: await sha256Hex(lockfile.bytes) };
};

/** package.json with every dependency field gone, so worker-bundler has nothing to install. */
const withoutDependencies = (text: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MountRefused("package.json is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new MountRefused("package.json is not a JSON object");
  const kept = Object.fromEntries(
    Object.entries(parsed).filter(
      ([key]) => !(DEPENDENCY_FIELDS as readonly string[]).includes(key),
    ),
  );
  return JSON.stringify(kept);
};

/** The isolate's entry: runs the probe through Keel's `vitest` and says which isolate answered. */
const entrySource = (probe: string): string =>
  [
    `import { __keel } from "vitest";`,
    ``,
    `// Set on the first request: random values are not allowed at global scope.`,
    `let instance;`,
    `let served = 0;`,
    ``,
    `export default {`,
    `  async fetch(request) {`,
    `    instance ??= crypto.randomUUID();`,
    `    served++;`,
    `    if (new URL(request.url).pathname === "/instance") return Response.json({ instance, served });`,
    `    const { stdout, exit } = await __keel.run(() => import(${JSON.stringify(`./${probe}`)}));`,
    `    return Response.json({ stdout, exit, instance, served });`,
    `  },`,
    `};`,
  ].join("\n");

/**
 * Lays a probe over a world for worker-bundler:
 *
 * - the world's files, less its `.keel/guards/` (a run never reads a guard
 *   from the candidate's tree), any `node_modules`, and `pyproject.toml`;
 * - its package.json with every dependency field stripped, so the bundler
 *   has nothing to install from npm;
 * - the probe's files at their own paths, all under `.keel/`, colliding with
 *   nothing, with exactly one `*.test.*` file;
 * - the deps bundle's `node_modules`, hoisted, when the world needs one;
 * - the entry.
 *
 * Files that are not UTF-8 are left out: the bundler reads text only.
 */
export const probeWorkerFiles = (
  world: readonly BundleFile[],
  probe: readonly BundleFile[],
  deps: readonly BundleFile[] | undefined,
): ProbeWorker => {
  const files: Record<string, string> = {};
  for (const file of world) {
    if (
      file.path.startsWith(GUARDS_ROOT) ||
      inNodeModules(file.path) ||
      file.path === "pyproject.toml"
    )
      continue;
    const text = textOf(file);
    if (text === undefined) continue;
    files[file.path] = file.path === "package.json" ? withoutDependencies(text) : text;
  }

  const tests: string[] = [];
  for (const file of probe) {
    if (!file.path.startsWith(PROBE_ROOT))
      throw new MountRefused(`${file.path} is outside ${PROBE_ROOT}`);
    if (Object.hasOwn(files, file.path))
      throw new MountRefused(`${file.path} is already in the world`);
    const text = textOf(file);
    if (text === undefined) throw new MountRefused(`${file.path} is not UTF-8 text`);
    files[file.path] = text;
    if (PROBE_TEST.test(file.path)) tests.push(file.path);
  }
  const test = tests[0];
  if (tests.length !== 1 || test === undefined)
    throw new MountRefused(`a probe has exactly one *.test.* file, this one has ${tests.length}`);

  for (const file of deps ?? []) {
    if (!file.path.startsWith("node_modules/")) continue;
    const text = textOf(file);
    if (text !== undefined) files[file.path] = text;
  }

  if (Object.hasOwn(files, PROBE_ENTRY))
    throw new MountRefused(`${PROBE_ENTRY} is already in the world`);
  files[PROBE_ENTRY] = entrySource(test);
  return { files, entry: PROBE_ENTRY, probe: test };
};
