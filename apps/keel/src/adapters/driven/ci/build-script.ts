/**
 * Where the box finds the bundler: rolldown, which a project that builds with
 * vite has among its dependencies. Keel bundles with it until a build runs the
 * project's own wrangler, which needs an upload from the box.
 */
export const ROLLDOWN_IN_WORKSPACE =
  "/workspace/node_modules/.pnpm/node_modules/rolldown/dist/index.mjs";

/**
 * The build script the box runs with node, as an ES module: it reads the
 * wrangler config at `argv[3]` as wrangler reads JSONC (comments and trailing
 * commas go, strings stay), takes `main` from it, and bundles that entry with
 * the rolldown at `argv[2]` into one ES module at `argv[4]`: Workers' import
 * conditions, `cloudflare:` and `node:` left to the runtime, every dynamic
 * import inlined. A config it cannot read exits 2, naming why; a bundle that
 * fails exits 1 with rolldown's errors. Keel judges the config again from its
 * text, so this only has to find the entry.
 */
export const BUILD_SCRIPT = `import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [rolldownAt, configPath, out] = process.argv.slice(2);
const pastBlank = (source, i) => {
  let j = i;
  for (;;) {
    while (j < source.length && /\\s/.test(source[j])) j += 1;
    if (source.startsWith("//", j)) {
      const end = source.indexOf("\\n", j);
      j = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", j)) {
      const end = source.indexOf("*/", j + 2);
      j = end === -1 ? source.length : end + 2;
    } else return j;
  }
};
const jsonOf = (source) => {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== '"') j += source[j] === "\\\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      i = pastBlank(source, i);
    } else if (c === ",") {
      const j = pastBlank(source, i + 1);
      if (source[j] !== "}" && source[j] !== "]") out += c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
};
if (configPath.endsWith(".toml")) {
  console.error("Keel reads wrangler.jsonc or wrangler.json, not TOML yet");
  process.exit(2);
}
let config;
try {
  config = JSON.parse(jsonOf(readFileSync(configPath, "utf8")));
} catch (error) {
  console.error(\`\${configPath}: \${error instanceof Error ? error.message : String(error)}\`);
  process.exit(2);
}
const main = config === null || typeof config !== "object" ? undefined : config.main;
if (typeof main !== "string" || main.length === 0) {
  console.error(\`\${configPath} names no main\`);
  process.exit(2);
}
try {
  const { rolldown } = await import(pathToFileURL(rolldownAt).href);
  const bundle = await rolldown({
    input: resolve(dirname(configPath), main),
    platform: "neutral",
    resolve: {
      conditionNames: ["workerd", "worker", "browser", "import", "module", "default"],
      mainFields: ["module", "main"],
    },
    external: [/^cloudflare:/, /^node:/],
  });
  await bundle.write({ file: out, format: "esm", codeSplitting: false });
  await bundle.close();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`;
