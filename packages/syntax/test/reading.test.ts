/**
 * What a reading asks its caller: the kind of a seed, or of a path an earlier
 * `lookups()` named, and nothing else. A caller that learns kinds a directory
 * at a time, listing only the directories of those paths, reads exactly what
 * a caller that knows the whole tree reads.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { openReading, type PathKind, type ReadingResult, readTree } from "../src/index.ts";
import { parser } from "./support/parser.ts";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 100, ...(seed === undefined ? {} : { seed: Number(seed) }) });

/** A property of a hundred pairs of readings takes a few seconds alone, and longer under load. */
const PROPERTY_TIMEOUT = 60_000;

type Entry = { readonly kind: "file" | "other"; readonly text: string };
type Tree = ReadonlyMap<string, Entry>;

/** The directory a path is in: `""` for one at the root. */
const directoryOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/**
 * Reads `tree` from `seeds` as a caller does that lists directories:
 * `list` is told the seeds before the reading opens, and each level's
 * `lookups()` before the next level is asked for.
 */
async function drive(
  tree: Tree,
  seeds: readonly string[],
  kindOf: (path: string) => PathKind,
  list: (paths: readonly string[]) => void = () => undefined,
): Promise<ReadingResult> {
  const encoder = new TextEncoder();
  const up = await parser();
  list(seeds);
  const reading = openReading(seeds, kindOf);
  for (let wanted = reading.wanted(); wanted.length > 0; wanted = reading.wanted()) {
    for (const path of wanted)
      expect(reading.give(path, encoder.encode(tree.get(path)?.text ?? ""), up)).toBe("taken");
    list(reading.lookups());
  }
  list(reading.lookups());
  return reading.result();
}

/** Every path a tree may hold: files and directories named alike, so imports land on some and miss others. */
const PATHS = [
  "a.ts",
  "b.js",
  "index.ts",
  "pkg.ts",
  "src/a.ts",
  "src/b.ts",
  "src/b.js",
  "src/c.mts",
  "src/data.json",
  "src/dir.ts",
  "src/dir/a.ts",
  "src/dir/index.ts",
  "src/dir/index.js",
  "src/index.ts",
  "src/lib/a.ts",
  "src/lib/b.js",
  "src/lib/index.ts",
  "src/lib/deep/a.ts",
  "src/lib/deep/index.js",
  "src/pkg.ts",
  "src/pkg/index.ts",
  "app/a.ts",
  "app/dir/index.ts",
  "app/dir/b.ts",
];

/** The relative specifier a file at `from` writes for the file at `to`. */
const toward = (from: string, to: string): string => {
  const here = from.split("/").slice(0, -1);
  const there = to.split("/");
  let common = 0;
  while (common < here.length && common < there.length - 1 && here[common] === there[common])
    common += 1;
  const up = here.length - common;
  return `${up === 0 ? "./" : "../".repeat(up)}${there.slice(common).join("/")}`;
};

/** How a file writes a module it names, from where it is. */
type Module =
  | { readonly to: string; readonly as: "itself" | "no-ending" | "js-for-ts" | "directory" }
  | { readonly literal: string };
const write = (from: string, module: Module): string => {
  if ("literal" in module) return module.literal;
  const exact = toward(from, module.to);
  return module.as === "no-ending"
    ? exact.replace(/\.[a-z]+$/, "")
    : module.as === "js-for-ts"
      ? exact.replace(/\.ts$/, ".js")
      : module.as === "directory"
        ? exact.replace(/\/index\.[a-z]+$/, "")
        : exact;
};

/** A path a tree may hold, written as its importer would; a relative path that may miss or leave the root; or a bare name. */
const anyModule: fc.Arbitrary<Module> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      to: fc.constantFrom(...PATHS),
      as: fc.constantFrom("itself", "no-ending", "js-for-ts", "directory"),
    }),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.constantFrom("./", "../", "../../", "../../../../", "./lib/../"),
        fc.constantFrom("", "dir/", "lib/", "missing/"),
        fc.constantFrom("a", "b", "index", "dir", "lib", "nothing"),
        fc.constantFrom("", ".js", ".ts", ".mjs"),
      )
      .map((parts) => ({ literal: parts.join("") })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(".", "./", "..", "pkg", "dir", "lib/a", "@scope/pkg")
      .map((literal) => ({ literal })),
  },
);
type Statement = { readonly form: string; readonly module: Module; readonly name: string };
const statement: fc.Arbitrary<Statement> = fc.record({
  form: fc.constantFrom("import", "reexport", "star", "dynamic"),
  module: anyModule,
  name: fc.constantFrom("fn", "r0", "r1", "r2", "gone"),
});

/** A file at `path` that names each module in one statement, keeps a store, and calls what it imports. */
const source = (path: string, statements: readonly Statement[]) =>
  [
    ...statements.map(({ form, module, name }, i) => {
      const from = write(path, module);
      return form === "import"
        ? `import { ${name} as f${i} } from "${from}";`
        : form === "reexport"
          ? `export { fn as r${i} } from "${from}";`
          : form === "star"
            ? `export * from "${from}";`
            : `export const d${i} = () => import("${from}");`;
    }),
    "const store = new Map<string, number>();",
    "export function fn(key: string) {",
    ...statements.flatMap(({ form }, i) => (form === "import" ? [`  f${i}(key);`] : [])),
    "  return store.get(key);",
    "}",
  ].join("\n");

const tree = fc
  .uniqueArray(
    fc.record({
      path: fc.constantFrom(...PATHS),
      kind: fc.constantFrom("file", "file", "file", "file", "other"),
      statements: fc.array(statement, { maxLength: 5 }),
      broken: fc.nat({ max: 9 }).map((n) => n === 0),
    }),
    { selector: (entry) => entry.path, minLength: 4, maxLength: 18 },
  )
  .map(
    (entries): Tree =>
      new Map(
        entries.map(({ path, kind, statements, broken }) => [
          path,
          {
            kind,
            text: `${source(path, statements)}${broken ? "\nexport function (" : ""}`,
          },
        ]),
      ),
  );
/** Seeds: mostly the tree's own files, by their place in it, and some paths no tree holds or none can. */
const seeds = fc.uniqueArray(
  fc.oneof(
    { weight: 4, arbitrary: fc.nat() },
    {
      weight: 1,
      arbitrary: fc.constantFrom(...PATHS, "src/gone.ts", "../outside.ts", "src/./a.ts", "src"),
    },
  ),
  { minLength: 1, maxLength: 4 },
);

describe("a reading that learns kinds a directory at a time", () => {
  it(
    "[reading.lazy-equals-whole] reads any tree from any seeds exactly as a reading that knows the whole tree, asking only about paths in the directories listed so far",
    async () => {
      let followed = 0;
      let indexed = 0;
      await fc.assert(
        fc.asyncProperty(tree, seeds, async (files, picked) => {
          const held = [...files.keys()];
          const from = [
            ...new Set(
              picked.map((at) => (typeof at === "string" ? at : (held[at % held.length] ?? ""))),
            ),
          ];
          const whole = await drive(files, from, (path) => files.get(path)?.kind);
          const listed = new Set<string>();
          const lazy = await drive(
            files,
            from,
            (path) => {
              if (!listed.has(directoryOf(path)))
                throw new Error(`${path} was asked about before its directory was listed`);
              if (!from.includes(path) && files.has(path)) {
                followed += 1;
                if (/\/index\.[jt]s$/.test(path)) indexed += 1;
              }
              return files.get(path)?.kind;
            },
            (paths) => {
              for (const path of paths) listed.add(directoryOf(path));
            },
          );
          expect(lazy).toEqual(whole);
        }),
      );
      // Imports were followed, through a directory's index among them, so the readings had more to agree on than their seeds.
      expect(followed).toBeGreaterThan(100);
      expect(indexed).toBeGreaterThan(20);
    },
    PROPERTY_TIMEOUT,
  );
});

const STORE = (name: string) =>
  `const ${name} = new Map<string, number>();\nexport function ${name}Of(key: string) { return ${name}.get(key); }\n`;
/** Each file a module named `base` may be, the directory's index last. */
const tried = (base: string) =>
  [".ts", ".mts", ".cts", ".js", "/index.ts", "/index.js"].map((ending) => `${base}${ending}`);

describe("a reading's lookups", () => {
  it("[reading.lookups] after a level, names every file each module the level names may be, a directory's index among them, and kinds are asked only of the seeds and of what was named before", async () => {
    const files: Readonly<Record<string, string>> = {
      "src/a.ts": [
        `import { bOf } from "./b";`,
        `import { cOf } from "../lib/c.js";`,
        `export * from "pkg";`,
        `export const later = () => import("./dir");`,
        `export function a(key: string) { return bOf(key) ?? cOf(key); }`,
      ].join("\n"),
      "src/b.ts": STORE("b"),
      "lib/c.ts": STORE("c"),
      "src/dir/index.ts": STORE("d"),
      "src/unrelated.ts": STORE("u"),
    };
    const named = new Set(["src/a.ts"]);
    const asked: string[] = [];
    const unnamed: string[] = [];
    const reading = openReading(["src/a.ts"], (path) => {
      asked.push(path);
      if (!named.has(path)) unnamed.push(path);
      return path in files ? "file" : undefined;
    });
    const lookups = () => {
      const paths = reading.lookups();
      for (const path of paths) named.add(path);
      return paths;
    };
    const up = await parser();
    const give = (path: string) =>
      expect(reading.give(path, new TextEncoder().encode(files[path] ?? ""), up)).toBe("taken");

    expect(lookups()).toEqual([]);
    expect(reading.wanted()).toEqual(["src/a.ts"]);
    give("src/a.ts");
    const first = lookups();
    expect(first).toEqual(
      [
        ...tried("src/b"),
        "lib/c.js",
        "lib/c.ts",
        ...tried("lib/c.js"),
        ...tried("src/dir"),
        // A bare re-export's source is resolved as if it were relative when a name is looked up through it.
        ...tried("src/pkg"),
      ].toSorted(),
    );
    expect(first).toContain("src/dir/index.ts");
    expect(asked).toEqual(["src/a.ts"]);

    expect(reading.wanted()).toEqual(["lib/c.ts", "src/b.ts", "src/dir/index.ts"]);
    expect(asked).toContain("src/dir/index.ts");
    for (const path of ["lib/c.ts", "src/b.ts", "src/dir/index.ts"]) give(path);
    expect(lookups()).toEqual([]);
    expect(reading.wanted()).toEqual([]);
    const result = reading.result();

    expect(unnamed).toEqual([]);
    expect(result).toEqual(await readTree(parser, files, ["src/a.ts"]));
    expect(result).toHaveProperty("facts.calls", [
      {
        from: { path: "src/a.ts", symbol: "a" },
        to: { path: "lib/c.ts", symbol: "cOf" },
        deferred: false,
      },
      {
        from: { path: "src/a.ts", symbol: "a" },
        to: { path: "src/b.ts", symbol: "bOf" },
        deferred: false,
      },
    ]);
  });
});
