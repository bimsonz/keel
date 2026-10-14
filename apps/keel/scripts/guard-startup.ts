// What keel's Worker evaluates as it loads, read from esbuild's metafile of the
// dry-run build. Cloudflare refuses a version whose global scope takes more
// than a second of CPU (10021), and keel's deploy of 14 Oct was refused once
// and passed on a retry: the HTTP side (better-auth, the generated validators,
// the MCP server) and every RPC codec were built as the Worker loaded. The
// HTTP side now loads on the first request, through the `import()` in
// src/index.ts, and the codecs on first use.
//
// This fails the build when any of the HTTP side is reached from the entry
// again with no `import()` between, naming the imports that reach it, or when
// the code evaluated at load grows past a ceiling well short of the size
// Cloudflare refused.
//
//   node scripts/guard-startup.ts <metafile>
import { readFileSync } from "node:fs";

/** Modules only the HTTP side needs: none of them is evaluated before the first request. */
const DEFERRED: [RegExp, string][] = [
  [/(^|\/)src\/composition\/isolate\.ts$/, "the HTTP side's composition"],
  [/(^|\/)src\/generated\/http\//, "the generated HTTP routes and validators"],
  [/(^|\/)src\/generated\/mcp\//, "the generated MCP tools"],
  [/\/node_modules\/better-auth\//, "better-auth"],
  [/\/node_modules\/@better-auth\//, "better-auth's plugins"],
  [/\/node_modules\/@modelcontextprotocol\//, "the MCP server"],
  [/(^|\/)packages\/contracts\/openapi\.json$/, "the OpenAPI document"],
];

/**
 * The most code, in bytes of the built script, that may be evaluated at load. On 14 Oct it was 3.87 MB with the
 * HTTP side deferred; with it eager it was 8.82 MB, and Cloudflare refused that once.
 */
const CEILING = 5_000_000;

interface Metafile {
  inputs: Record<string, { imports: { path: string; kind: string; external?: boolean }[] }>;
  outputs: Record<
    string,
    { entryPoint?: string; inputs: Record<string, { bytesInOutput: number }> }
  >;
}

const isMetafile = (value: unknown): value is Metafile =>
  typeof value === "object" &&
  value !== null &&
  ["inputs", "outputs"].every((field) => typeof Reflect.get(value, field) === "object");

const path = process.argv[2];
if (path === undefined) throw new Error("usage: guard-startup.ts <metafile>");
const meta: unknown = JSON.parse(readFileSync(path, "utf8"));
if (!isMetafile(meta)) throw new Error(`${path} is not an esbuild metafile`);
const output = Object.values(meta.outputs).find((o) => o.entryPoint !== undefined);
if (output?.entryPoint === undefined) throw new Error(`${path} names no entry point`);
const entry = output.entryPoint;

// Each module reached from the entry by imports that are evaluated as they load, with the module that reached it.
const reachedFrom = new Map<string, string | null>([[entry, null]]);
const queue = [entry];
for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
  for (const ref of meta.inputs[at]?.imports ?? []) {
    if (ref.external === true || ref.kind === "dynamic-import" || reachedFrom.has(ref.path))
      continue;
    reachedFrom.set(ref.path, at);
    queue.push(ref.path);
  }
}

const chainTo = (module: string): string[] => {
  const chain: string[] = [];
  for (let at: string | null | undefined = module; at != null; at = reachedFrom.get(at))
    chain.unshift(at.replace(/^.*\/node_modules\/\.pnpm\/[^/]+\/node_modules\//, ""));
  return chain;
};

const failures: string[] = [];
// The guard reads a build that has the HTTP side in it at all: one with none would pass on nothing.
for (const [pattern, what] of DEFERRED.slice(0, 2))
  if (!Object.keys(output.inputs).some((input) => pattern.test(input)))
    failures.push(`vacuous: the build holds none of ${what}, so this read nothing it guards`);
for (const [pattern, what] of DEFERRED) {
  const eager = [...reachedFrom.keys()].find((module) => pattern.test(module));
  if (eager !== undefined)
    failures.push(
      `${what} is evaluated as the Worker loads, reached by:\n    ${chainTo(eager).join("\n    → ")}`,
    );
}
let bytes = 0;
for (const [input, { bytesInOutput }] of Object.entries(output.inputs))
  if (reachedFrom.has(input)) bytes += bytesInOutput;
if (bytes > CEILING)
  failures.push(
    `${bytes} bytes are evaluated as the Worker loads, over the ceiling of ${CEILING}: defer what the handlers alone need behind an import()`,
  );

console.log(
  `startup: ${reachedFrom.size} of ${Object.keys(meta.inputs).length} modules, ${bytes} bytes evaluated at load (ceiling ${CEILING})`,
);
for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
