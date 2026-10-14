import { describe, expect, it } from "vitest";
import {
  BENCH_KINDS,
  PENDING,
  anchoredAt,
  apply,
  mix,
  planRun,
  sealed,
  type Edit,
  type Plan,
  type Task,
} from "../src/plan.ts";

const plan = (count: number, seed = 42) => planRun({ run: "r1", seed, count });

const sidesOf = (p: Plan, pair: number): [Task, Task] => {
  const key = p.key.find((k) => k.pair === pair);
  const a = p.tasks[key?.a ?? -1];
  const b = p.tasks[key?.b ?? -1];
  if (a === undefined || b === undefined) throw new Error(`pair ${pair} has no sides`);
  return [a, b];
};

/** The functions an edit touches in a file of the pair's, or none for a file of its own. */
const touched = (edit: Edit) => (edit.op === "create" ? [] : [`${edit.path}#${edit.fn}`]);

const anchors = (q: Plan) =>
  q.tasks.flatMap((t) => t.premises.flatMap((premise) => premise.anchors ?? []));

describe("a loadgen run's plan", () => {
  it("[loadgen.plan-mix] splits every agent count into pairs, shared groups and disjoint agents, a pair's sides started together", () => {
    for (const count of [5, 50, 200, 1000]) {
      const p = plan(count);
      const split = mix(count);
      expect(split.pairs * 2 + split.shared + split.disjoint).toBe(count);
      expect(split.pairs).toBeGreaterThanOrEqual(1);
      expect(p.tasks.map((t) => t.index)).toEqual(Array.from({ length: count }, (_, i) => i));
      expect(p.tasks.filter((t) => t.kind === "shared")).toHaveLength(split.shared);
      expect(p.key).toHaveLength(split.pairs);
      for (const k of p.key) {
        expect(k.b).toBe(k.a + 1);
        expect([p.tasks[k.a]?.side, p.tasks[k.b]?.side]).toEqual(["a", "b"]);
      }
      // Every path is the run's own, and every edited file is in the base.
      const paths = new Set(p.base.map((f) => f.path));
      expect(p.tasks.filter((t) => !t.edit.path.startsWith(`${p.dir}/`))).toEqual([]);
      expect(p.tasks.filter((t) => t.edit.op !== "create" && !paths.has(t.edit.path))).toEqual([]);
    }
    expect(mix(1000)).toEqual({ pairs: 50, shared: 300, disjoint: 600 });
  });

  it("[loadgen.plan-seeded] is the same plan, and the same sealed digest, from the same seed, and another from another", () => {
    expect(plan(200, 7)).toEqual(plan(200, 7));
    expect(sealed(plan(200, 7)).sha256).toBe(sealed(plan(200, 7)).sha256);
    expect(sealed(plan(200, 8)).sha256).not.toBe(sealed(plan(200, 7)).sha256);
    expect(sealed(plan(200, 7)).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[loadgen.plan-balanced] plants every kind, half of each planted and half decoy, in no fixed order", () => {
    const p = plan(1000);
    for (const kind of BENCH_KINDS) {
      const ofKind = p.key.filter((k) => k.kind === kind);
      expect(ofKind.length).toBeGreaterThanOrEqual(12);
      const planted = ofKind.filter((k) => k.planted).length;
      expect(Math.abs(planted - (ofKind.length - planted))).toBeLessThanOrEqual(1);
    }
    // The kinds are not in the order they were dealt.
    const dealt = p.key.map((_, k) => BENCH_KINDS[k % BENCH_KINDS.length]);
    expect(p.key.map((k) => k.kind)).not.toEqual(dealt);
  });

  it("[loadgen.plan-planted] makes a planted pair conflict in its kind, and its decoy look alike without conflicting", () => {
    const p = plan(1000);
    // What each pair's two sides do, read from the plan; then what its kind and seal say they must.
    const observed = p.key.map((k) => {
      const [a, b] = sidesOf(p, k.pair);
      const fns = [...touched(a.edit), ...touched(b.edit)];
      const values = [...a.premises, ...b.premises].map((premise) => premise.value);
      return {
        pair: k.pair,
        premiseValues: new Set(values).size,
        functionsTouched: fns.length,
        sameFunction: fns.length === 2 && fns[0] === fns[1],
        impure: a.edit.op === "replace" && a.edit.text.includes("console."),
        removed: a.edit.op === "remove" ? a.edit.fn : undefined,
        callsLabel: b.edit.op === "create" && b.edit.content.includes("import { label }"),
      };
    });
    const expected = p.key.map((k) => ({
      pair: k.pair,
      premiseValues: k.kind === "premise" ? (k.planted ? 2 : 1) : k.kind === "effect" ? 1 : 0,
      functionsTouched: k.kind === "textual" ? 2 : k.kind === "premise" ? 0 : 1,
      sameFunction: k.kind === "textual" && k.planted,
      impure: k.kind === "effect" && k.planted,
      removed: k.kind === "interaction" ? (k.planted ? "label" : "legacyLabel") : undefined,
      callsLabel: k.kind === "interaction",
    }));
    expect(observed).toEqual(expected);
  });

  it("[loadgen.plan-apply] edits only the function it names, so edits to two functions land the same in either order", () => {
    const p = plan(50);
    const file = p.base.find((f) => f.path.includes("/shared/"));
    if (file === undefined) throw new Error("no shared file");
    const edits = p.tasks.flatMap((t) => (t.edit.path === file.path ? [t.edit] : []));
    expect(edits.length).toBeGreaterThanOrEqual(2);
    const forward = edits.reduce<string>((text, e) => apply(e, text), file.content);
    const backward = edits.toReversed().reduce<string>((text, e) => apply(e, text), file.content);
    expect(backward).toBe(forward);
    const texts = edits.flatMap((e) => (e.op === "replace" ? [e.text] : []));
    expect(texts.filter((text) => !forward.includes(text))).toEqual([]);

    const bench = p.base.find((f) => f.path.includes("/bench/"));
    if (bench === undefined) throw new Error("no bench file");
    const gone = apply({ op: "remove", path: bench.path, fn: "label" }, bench.content);
    expect([gone.includes("function label("), gone.includes("function legacyLabel(")]).toEqual([
      false,
      true,
    ]);
    expect(() => apply({ op: "remove", path: bench.path, fn: "label" }, gone)).toThrow(
      "label is not in",
    );
  });

  it("[loadgen.plan-anchored] anchors every premise at the commit the base landed on, and only once it has", () => {
    const p = plan(200);
    expect(anchors(p).length).toBeGreaterThan(0);
    expect(new Set(anchors(p).map((a) => a.commit))).toEqual(new Set([PENDING]));
    const sha = "a".repeat(40);
    expect(new Set(anchors(anchoredAt(p, sha)).map((a) => a.commit))).toEqual(new Set([sha]));
  });
});
