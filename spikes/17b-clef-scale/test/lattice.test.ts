import { describe, expect, it } from "vitest";
import { buildDataset } from "../scripts/build-dataset.ts";
import { LATTICES, compare, violating } from "../src/lattice.ts";
import { variantsFor } from "../src/questions.ts";

describe("lattice", () => {
  const premise = { subject: "authz.permission-evaluation", predicate: "freshness", relation: "le", value: "per-request", scope: "s" } as const;
  it("flags the forge-lite S-1 effect and accepts a per-request memo", () => {
    expect(compare(premise, "per-session")).toBe("contradiction");
    expect(compare(premise, "per-request")).toBe("compatible");
    expect(compare(premise, "per-call")).toBe("compatible");
    expect(compare(premise, "unclear")).toBe("abstain");
  });
  it("sums contradiction mass over the weaker values only", () => {
    expect(violating(premise)).toEqual(["per-session", "ttl", "static"]);
  });
  it("compares shape for equality", () => {
    const p = { subject: "x", predicate: "shape", relation: "eq", value: "integer", scope: "s" } as const;
    expect(compare(p, "string")).toBe("contradiction");
    expect(compare(p, "integer")).toBe("compatible");
  });
});

describe("dataset", () => {
  const ds = buildDataset();
  it("has at least 200 items, about a quarter decoys, labels recomputed on the lattice", () => {
    expect(ds.composition.total).toBeGreaterThanOrEqual(200);
    expect(ds.composition.decoyShare).toBeGreaterThan(0.2);
    expect(ds.composition.decoyShare).toBeLessThan(0.3);
    for (const item of ds.items) expect(compare(item.premise, item.groundTruthEffect.value)).toBe(item.label);
    for (const item of ds.items.filter((i) => i.kind === "decoy")) expect(item.label).toBe("compatible");
  });
  it("holds out S17's 40 items (22 contradictions) and the forge-lite S-1/S-2 variants", () => {
    const s17 = ds.items.filter((i) => i.source === "s17");
    expect(s17).toHaveLength(40);
    expect(s17.filter((i) => i.label === "contradiction")).toHaveLength(22);
    const forge = ds.items.filter((i) => i.source === "forge-lite");
    expect(forge.map((i) => `${i.id}:${i.label}`)).toEqual([
      "F01:contradiction", "F02:contradiction", "F03:compatible", "F04:contradiction",
      "F05:compatible", "F06:contradiction", "F07:compatible", "F08:compatible",
    ]);
  });
  it("covers every predicate, every effect value and all five languages", () => {
    for (const [p, l] of Object.entries(LATTICES)) {
      const seen = new Set(ds.items.filter((i) => i.premise.predicate === p).map((i) => i.groundTruthEffect.value));
      expect([...l.values].filter((v) => !seen.has(v))).toEqual([]);
    }
    expect(Object.keys(ds.composition.byLanguage).toSorted()).toEqual(["c", "go", "hcl", "python", "typescript"]);
  });
});

describe("permutations", () => {
  it("yields three distinct presented orders, so sorted option ids really move", () => {
    const vs = variantsFor("C01", { subject: "a", predicate: "freshness", relation: "le", value: "per-request", scope: "s" });
    const sortedIds = vs.map((v) => Object.keys(v.valueOf).toSorted().map((id) => v.valueOf[id]).join(","));
    expect(new Set(sortedIds).size).toBe(3);
  });
});
