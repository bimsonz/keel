import { readTree, type ReadingResult, type TreeFacts } from "../../src/index.ts";
import { parser } from "./parser.ts";

const ref = (r: { readonly path: string; readonly symbol: string }) => `${r.path}#${r.symbol}`;

/** Facts as lines, in one order whatever order they were reported in. */
export const lines = (facts: TreeFacts) => ({
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

export type Tree = Readonly<Record<string, string | Uint8Array>>;

/** A reading of `tree` from `seeds` (every file, when none are given). */
export const reading = (tree: Tree, seeds?: readonly string[]): Promise<ReadingResult> =>
  readTree(parser, tree, seeds ?? Object.keys(tree));

/** The facts of a reading that must succeed. */
export async function factsOf(tree: Tree, seeds?: readonly string[]) {
  const result = await reading(tree, seeds);
  if ("unavailable" in result) throw new Error(`no reading: ${result.unavailable}`);
  return { ...lines(result.facts), skipped: result.skipped };
}
