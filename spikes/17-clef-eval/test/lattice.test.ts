import { describe, expect, it } from "vitest";
import { buildDataset } from "../scripts/build-dataset.ts";
import { compare, violating } from "../src/lattice.ts";
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
  it("has 30 core items (22 contradictions) and 10 compatible decoys, labels recomputed on the lattice", () => {
    const ds = buildDataset();
    expect(ds.composition).toMatchObject({ core: 30, coreContradiction: 22, coreCompatible: 8, decoys: 10 });
    for (const item of ds.items) expect(compare(item.premise, item.groundTruthEffect.value)).toBe(item.label);
  });
});

describe("permutations", () => {
  it("yields three distinct presented orders, so sorted option ids really move", () => {
    const vs = variantsFor("C01", { subject: "a", predicate: "freshness", relation: "le", value: "per-request", scope: "s" });
    const sortedIds = vs.map((v) => Object.keys(v.valueOf).toSorted().map((id) => v.valueOf[id]).join(","));
    expect(new Set(sortedIds).size).toBe(3);
  });
});
