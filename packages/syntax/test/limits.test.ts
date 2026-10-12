/**
 * What bounds a reading: the path rule and its caps, and the two budgets a
 * stranger's file is parsed inside.
 */
import { forgeLiteTrees } from "@keeltown/testing";
import { describe, expect, it } from "vitest";
import { LIMITS, openReading, parseBudget } from "../src/index.ts";
import { factsOf, reading } from "./support/facts.ts";
import { parser } from "./support/parser.ts";

const STORE = (name: string) => `
const ${name} = new Map<string, number>();
export function ${name}Of(key: string) {
  if (!${name}.has(key)) ${name}.set(key, 1);
  return ${name}.get(key);
}
`;
/** `bytes` of source that parses at once: one comment. */
const padding = (bytes: number) => `/* ${"x".repeat(bytes - 6)} */`;
/** 16 KB that grows the parser's heap past any cap: a call left open, every argument a comparison or a generic. */
const HOSTILE = `f(${"a<b,".repeat(4096)}`;

const many = (count: number) =>
  Array.from({ length: count }, (_, i) => `src/f${String(i).padStart(3, "0")}.ts`);

/** A read of a store wrapped in `calls` calls, one inside the next. */
const nested = (calls: number) => `
const seen = new Map<string, number>();
export function deep(key: string) {
  return ${"wrap(".repeat(calls)}seen.get(key)${")".repeat(calls)};
}
`;

describe("the path rule", () => {
  it("[syntax.path-rule] reads the seeds and what they import, to a fixpoint, and nothing else", async () => {
    const facts = await factsOf(
      {
        "src/a.ts": `import { bOf } from "./b.ts";\nexport function a(key: string) { return bOf(key); }\n`,
        "src/b.ts": `export * from "./deep/c.ts";\nexport { bOf } from "./deep/c.ts";\n`,
        "src/deep/c.ts": `${STORE("b")}export const lazy = () => import("../d.ts");\n`,
        "src/d.ts": STORE("d"),
        "src/unrelated.ts": STORE("unrelated"),
        "src/view.tsx": "export const View = () => <p />;\n",
        "data.json": "{}",
        "src/latin1.ts": new Uint8Array([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0xe9, 0x3b]),
      },
      ["src/a.ts", "src/gone.ts", "src/view.tsx", "data.json", "src/latin1.ts", "../outside.ts"],
    );
    expect(facts.stores).toEqual(["src/d.ts#d module", "src/deep/c.ts#b module"]);
    expect(facts.calls).toEqual(["src/a.ts#a -> src/deep/c.ts#bOf"]);
    expect(facts.skipped).toEqual([
      { path: "../outside.ts", reason: "absent" },
      { path: "data.json", reason: "unsupported" },
      { path: "src/gone.ts", reason: "absent" },
      { path: "src/latin1.ts", reason: "unsupported" },
      { path: "src/view.tsx", reason: "unsupported" },
    ]);
  });

  it("[syntax.path-rule] stops at 400 files, 512 KB a file and 8 MB a call, and takes no more than 400 seeds", async () => {
    const wide = Object.fromEntries([
      [
        "src/root.ts",
        many(450)
          .map((path) => `import "./${path.slice(4)}";`)
          .join("\n"),
      ],
      ...many(450).map((path) => [path, "export {};\n"]),
    ]);
    const capped = await factsOf(wide, ["src/root.ts"]);
    expect(capped.skipped).toEqual(
      many(450)
        .slice(LIMITS.files - 1)
        .map((path) => ({ path, reason: "beyond-cap" })),
    );

    expect(await reading(wide, many(LIMITS.files))).toHaveProperty("facts");
    expect(await reading(wide, many(LIMITS.files + 1))).toEqual({ unavailable: "too-many-seeds" });

    const large = await factsOf({
      "src/large.ts": `${STORE("large")}${padding(LIMITS.fileBytes)}`,
      "src/fits.ts": `${STORE("fits")}${padding(LIMITS.fileBytes - 200)}`,
    });
    expect(large.skipped).toEqual([{ path: "src/large.ts", reason: "too-large" }]);
    expect(large.stores).toEqual(["src/fits.ts#fits module"]);

    const half = padding(LIMITS.fileBytes);
    const heavy = (count: number) => Object.fromEntries(many(count).map((path) => [path, half]));
    expect(await reading(heavy(LIMITS.totalBytes / LIMITS.fileBytes))).toHaveProperty("facts");
    expect(await reading(heavy(LIMITS.totalBytes / LIMITS.fileBytes + 1))).toEqual({
      unavailable: "too-many-bytes",
    });
  }, 60_000);

  it("[syntax.deterministic] the same tree gives the same reading whatever order its seeds come in and however its lines end, in one order", async () => {
    const { head } = forgeLiteTrees("F03");
    const seeds = Object.keys(head);
    const forwards = await reading(head, seeds);
    const backwards = await reading(
      Object.fromEntries(Object.entries(head).toReversed()),
      seeds.toReversed(),
    );
    const crlf = await reading(
      Object.fromEntries(
        Object.entries(head).map(([path, text]) => [path, text.replaceAll("\n", "\r\n")]),
      ),
      seeds,
    );
    expect(backwards).toEqual(forwards);
    expect(crlf).toEqual(forwards);
    if (!("facts" in forwards)) throw new Error("no reading");
    const at = forwards.facts.stores.map((store) => `${store.at.path}\n${store.at.symbol}`);
    expect(at.length).toBeGreaterThan(5);
    expect(at).toEqual(at.toSorted());
    const from = forwards.facts.calls.map((call) => `${call.from.path}\n${call.from.symbol}`);
    expect(from.length).toBeGreaterThan(5);
    expect(from).toEqual(from.toSorted());
    // Each level is asked for in path order, so the blobs are read in one order too.
    const level = openReading(seeds.toReversed(), () => "file").wanted();
    expect(level).toEqual(seeds.toSorted());
  });
});

describe("a stranger's file", () => {
  it("[syntax.broken-file-skipped] a file cut off anywhere is read whole or skipped whole, and never throws", async () => {
    const { head } = forgeLiteTrees("F03");
    const up = await parser();
    const broken: unknown[] = [];
    const skippedWhole: unknown[] = [];
    const whole: unknown[] = [];
    for (const path of ["src/authz/cache.ts", "src/authz/require-permission.ts"]) {
      const text = head[path] ?? "";
      const ends = [...text.matchAll(/\n/g)].map((match) => match.index + 1);
      for (const end of [...ends, ...ends.map((at) => at - 4)].filter((at) => at > 0)) {
        const cut = text.slice(0, end);
        const hasError = up.read(cut, (root) => root.hasError);
        // oxlint-disable-next-line no-await-in-loop -- one parser, one file at a time
        const facts = await factsOf({ [path]: cut });
        if (hasError === true) {
          broken.push(facts);
          skippedWhole.push({
            stores: [],
            accesses: [],
            calls: [],
            subscriptions: [],
            skipped: [{ path, reason: "syntax-error" }],
          });
        } else whole.push(facts.skipped);
      }
    }
    expect(broken).toEqual(skippedWhole);
    expect(whole).toEqual(whole.map(() => []));
    expect(broken.length).toBeGreaterThan(50);
    expect(whole.length).toBeGreaterThan(10);
  }, 60_000);

  it("[syntax.budget] a file that takes more parse work than its size allows is given up as too slow, and the rest is read", async () => {
    // Valid, and as dense as source gets: a statement every four bytes.
    const dense = "a.b;".repeat(65_536);
    expect(parseBudget(dense.length)).toBe(2_000 + 8_192);
    const started = performance.now();
    const facts = await factsOf({ "src/dense.ts": dense, "src/plain.ts": STORE("plain") });
    expect(facts.skipped).toEqual([{ path: "src/dense.ts", reason: "too-slow" }]);
    expect(facts.stores).toEqual(["src/plain.ts#plain module"]);
    // Generous: it takes about a tenth of a second on an idle machine.
    expect(performance.now() - started).toBeLessThan(30_000);
    // Source as people write it is nowhere near: forge-lite's largest file fits forty times over.
    expect(await factsOf(forgeLiteTrees("F03").head)).toHaveProperty("skipped", []);
  }, 60_000);

  it("[syntax.depth-cap] a file nested deeper than the reader follows is given up, however small, and one nested as deep as source gets is read", async () => {
    // Each call is two levels of the tree: 300 of them pass the cap in two kilobytes.
    const facts = await factsOf({ "src/deep.ts": nested(300), "src/z-fits.ts": nested(100) });
    expect(facts.skipped).toEqual([{ path: "src/deep.ts", reason: "unparseable" }]);
    expect(facts.accesses).toEqual([
      "read src/z-fits.ts#seen in src/z-fits.ts#deep by [key] expiring null",
    ]);
    // Far past it, where following the tree would overflow the stack: still an answer, never a throw.
    const far = await factsOf({ "src/far.ts": nested(5_000) });
    expect(far.skipped).toEqual([{ path: "src/far.ts", reason: "unparseable" }]);
  });

  it("[syntax.memory-cap] a file that grows the parser past its memory cap is given up, the parser is rebuilt for the next file, and four such files end the call", async () => {
    const one = await factsOf({
      "src/a-plain.ts": STORE("first"),
      "src/hostile.ts": HOSTILE,
      "src/z-plain.ts": STORE("last"),
    });
    expect(one.skipped).toEqual([{ path: "src/hostile.ts", reason: "unparseable" }]);
    expect(one.stores).toEqual(["src/a-plain.ts#first module", "src/z-plain.ts#last module"]);

    const hostile = (count: number) =>
      Object.fromEntries([
        ...Array.from({ length: count }, (_, i) => [`src/h${i}.ts`, HOSTILE]),
        ["src/z-plain.ts", STORE("last")],
      ]);
    const three = await factsOf(hostile(LIMITS.failures - 1));
    expect(three.skipped.map((skip) => skip.reason)).toEqual([
      "unparseable",
      "unparseable",
      "unparseable",
    ]);
    expect(three.stores).toEqual(["src/z-plain.ts#last module"]);
    expect(await reading(hostile(LIMITS.failures))).toEqual({ unavailable: "too-many-failures" });
    // The parser is whole again afterwards.
    expect((await factsOf({ "src/z-plain.ts": STORE("last") })).stores).toHaveLength(1);
  }, 60_000);
});
