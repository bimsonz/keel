/**
 * The purity rule on loadgen's effect pair, as the run lg50a planted it
 * (`examples/loadgen/src/plan.ts`): the text is read by tree-sitter, derived
 * by the domain, and judged by fallout against the premise the other side
 * held, so nothing between the parser and the conflict is stood in for.
 */
import {
  declaredEffect,
  deriveEffects,
  fallout,
  type Intent,
  SubjectKey,
  writeProposition,
} from "@keeltown/core/domain/coordination";
import { ChangeId, CommitSha, Glob } from "@keeltown/core/kernel";
import { describe, expect, it } from "vitest";
import { readTree } from "../src/index.ts";
import { parser } from "./support/parser.ts";

// loadgen's own strings, as `plan.ts` writes them.
const fnText = (name: string, ret: string, body: string) =>
  `export function ${name}(n: number): ${ret} {\n${body}\n}\n`;
const SEPARATOR = "\n// ----\n\n";
const fileOf = (fns: readonly string[]) => fns.join(SEPARATOR);
const priceText = (body: string) => fnText("price", "number", body);
const others = [
  fnText("label", "string", "  return `#${n}`;"),
  fnText("legacyLabel", "string", "  return `No. ${n}`;"),
];
const FILE = "bench/p2.ts";
const BASE = fileOf([priceText("  return n * 2;"), ...others]);
const PLANTED = fileOf([priceText('  console.info("priced", n);\n  return n * 2;'), ...others]);
const DECOY = fileOf([priceText("  return n + n;"), ...others]);
/** B's own file, which the premise is written beside. */
const B_FILE = {
  "bench/p2-b.ts": `import { price } from "./p2.ts";\n\n${fnText("useB2", "number", "  return price(n);")}`,
};

const SUBJECT = SubjectKey.make("lg50a.p2.price");
const A = ChangeId.make("chg_01M4XQVACBK7NN7HFN3RCD2WWK");
const B = ChangeId.make("chg_01M4XQY2T2YHB9Y7CPNE5BY9YF");
const BASE_SHA = CommitSha.make("b".repeat(40));
const HEAD_SHA = CommitSha.make("c".repeat(40));
const intent: Intent = {
  revision: 1,
  goal: "Rewrite price in pair 2's file",
  footprint: [{ path: Glob.make(FILE), op: "edit" }],
  premises: [],
  declaredEffects: [],
};
const premise = (strength: "must" | "should") =>
  writeProposition(
    SUBJECT,
    { predicate: "purity", relation: "is", value: true },
    { anchors: [{ path: FILE, symbol: "price", commit: BASE_SHA }], strength },
  );

const factsAt = async (text: string, commit: CommitSha) => {
  const reading = await readTree(parser, { [FILE]: text, ...B_FILE }, [FILE]);
  if ("unavailable" in reading) throw new Error(`no reading: ${reading.unavailable}`);
  expect(reading.skipped).toEqual([]);
  return { ...reading.facts, commit };
};
const derive = async (head: string) =>
  deriveEffects({
    base: await factsAt(BASE, BASE_SHA),
    head: await factsAt(head, HEAD_SHA),
    subjects: [{ subject: SUBJECT, anchors: [{ path: FILE, symbol: "price", commit: BASE_SHA }] }],
    intent,
  });

describe("lg50a's effect pair, read and judged", () => {
  it("[derive.purity-real] the planted `console.info` makes `price` impure, which is a conflict with a `must` premise that it is pure and a suspicion of a `should` one; the decoy derives nothing", async () => {
    const planted = await derive(PLANTED);
    expect(
      planted.effects.map((e) => [
        e.proposition.subject,
        e.proposition.predicate,
        e.proposition.relation,
        e.proposition.value,
        e.anchors,
        e.declared,
        e.proposition.gloss,
      ]),
    ).toEqual([
      [
        SUBJECT,
        "purity",
        "is",
        false,
        [{ path: FILE, symbol: "price", commit: HEAD_SHA }],
        false,
        "price calls console.info",
      ],
    ]);
    const [effect] = planted.effects;
    if (effect === undefined) throw new Error("no effect");

    const must = fallout(A, effect, [{ holder: B, proposition: premise("must") }], []);
    expect(must.map((f) => [f._tag, "kind" in f ? f.kind : undefined])).toEqual([
      ["conflict", "semantic"],
    ]);
    expect(must[0]?._tag === "conflict" && must[0].silentRetraction).toBe(true);
    const should = fallout(A, effect, [{ holder: B, proposition: premise("should") }], []);
    expect(should.map((f) => f._tag)).toEqual(["suspect"]);
    // The holder's own effect never turns on its own premise.
    expect(fallout(B, effect, [{ holder: B, proposition: premise("must") }], [])).toEqual([]);
    // Declared, it is a conflict still, but not a silent retraction.
    const declared = fallout(
      A,
      declaredEffect(effect.proposition),
      [{ holder: B, proposition: premise("must") }],
      [],
    );
    expect(declared[0]?._tag === "conflict" && declared[0].silentRetraction).toBe(false);

    expect((await derive(DECOY)).effects).toEqual([]);
  });
});
