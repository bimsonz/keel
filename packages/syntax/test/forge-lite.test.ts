import { deriveEffects, type Intent, type SourceFacts } from "@keeltown/core/domain/coordination";
import { CommitSha, Glob } from "@keeltown/core/kernel";
import {
  FORGE_LITE_ITEMS,
  FORGE_LITE_SUBJECTS,
  forgeLiteFactFiles,
  forgeLiteSeeds,
  type ForgeLiteItem,
  type ForgeLiteTree,
  forgeLiteTrees,
} from "@keeltown/testing";
import { describe, expect, it } from "vitest";
import { readTree, type TreeFacts } from "../src/index.ts";
import { parser } from "./support/parser.ts";

const ref = (r: { readonly path: string; readonly symbol: string }) => `${r.path}#${r.symbol}`;
/** Facts in one order, whatever order they were reported in. */
const canonical = (facts: TreeFacts | SourceFacts) => ({
  stores: facts.stores.map((s) => `${ref(s.at)} ${s.holder}${s.weak ? " weak" : ""}`).toSorted(),
  accesses: facts.accesses
    .map(
      (a) =>
        `${a.op} ${ref(a.store)} in ${ref(a.in)} by [${a.key.join(", ")}] expiring ${JSON.stringify(a.expiry ?? null)}${a.deferred ? " deferred" : ""}`,
    )
    .toSorted(),
  calls: facts.calls
    .map((c) => `${ref(c.from)} -> ${ref(c.to)}${c.deferred ? " deferred" : ""}`)
    .toSorted(),
  subscriptions: facts.subscriptions
    .map(
      (s) =>
        `${s.event} via ${s.via} in ${ref(s.in)} to ${ref(s.handler)}${s.async ? " async" : ""}`,
    )
    .toSorted(),
});

const read = async (tree: ForgeLiteTree, seeds: readonly string[]) => {
  const reading = await readTree(parser, tree, seeds);
  if ("unavailable" in reading) throw new Error("no reading");
  return reading;
};
/** Only the listed files, so no import leads anywhere: the facts the fixture was transcribed from. */
const factsOf = (tree: ForgeLiteTree, files: readonly string[]) =>
  read(
    Object.fromEntries(files.flatMap((path) => (path in tree ? [[path, tree[path] ?? ""]] : []))),
    files,
  );

const intent: Intent = {
  revision: 1,
  goal: "speed up permission checks",
  footprint: [{ path: Glob.make("src/**"), op: "edit" }],
  premises: [],
  declaredEffects: [],
};
const at = (digit: string) => CommitSha.make(digit.repeat(40));

describe("forge-lite's trees", () => {
  it.each(FORGE_LITE_ITEMS.map((item) => [item.id, item] as const))(
    "[syntax.forge-lite-facts] %s: the files the fixture was transcribed from give exactly its facts, base and head",
    async (_id, item: ForgeLiteItem) => {
      const files = forgeLiteFactFiles(item.id);
      const trees = forgeLiteTrees(item.id);
      const base = await factsOf(trees.base, files);
      const head = await factsOf(trees.head, files);
      expect(canonical(base.facts)).toEqual(canonical(item.base));
      expect(canonical(head.facts)).toEqual(canonical(item.head));
      expect([...base.skipped, ...head.skipped].filter((s) => s.reason !== "absent")).toEqual([]);
    },
  );

  it.each(FORGE_LITE_ITEMS.map((item) => [item.id, item] as const))(
    "[syntax.forge-lite-derives] %s: the whole tree, read from the seeds Precheck gives, derives exactly the item's effects",
    async (_id, item: ForgeLiteItem) => {
      const seeds = forgeLiteSeeds(item.id);
      const trees = forgeLiteTrees(item.id);
      const base = await read(trees.base, seeds);
      const head = await read(trees.head, seeds);
      const derived = deriveEffects({
        base: { commit: at("b"), ...base.facts },
        head: { commit: at("c"), ...head.facts },
        subjects: FORGE_LITE_SUBJECTS,
        intent,
      });
      expect(derived.effects.map((effect) => effect.proposition.value)).toEqual(item.derives);
      expect(derived.undecided).toEqual([]);
      // The import closure was read, not only the seeds, and nothing in it was given up on.
      expect(head.facts.stores.map((store) => store.at.path)).toContain("src/store/memory.ts");
      expect([...base.skipped, ...head.skipped].filter((s) => s.reason !== "absent")).toEqual([]);
    },
  );
});
