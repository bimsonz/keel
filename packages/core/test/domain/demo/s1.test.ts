/**
 * The forge-lite S-1 scenario, end to end through the domain: A relies on
 * permission evaluation being at most per-request; B, asked to speed up
 * permission checks, caches it per session and declares nothing.
 */
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  compare,
  type DerivedEffect,
  drift,
  exposure,
  fallout,
  type HeldPremise,
  type Intent,
  rankBets,
  probeCost,
  SubjectKey,
} from "../../../src/domain/coordination/index.ts";
import { contentHashOf, Glob, makeId } from "../../../src/domain/kernel/index.ts";
import {
  admit,
  coerce,
  compile,
  type ProbeCell,
  type StepSpec,
  verdict,
} from "../../../src/domain/verification/index.ts";
import { base, emptyDefaults, factClasses } from "../../arbitraries/flow.ts";

const show = (label: string, value: unknown): void => console.log(`S-1 ${label}: ${JSON.stringify(value)}`);

const chg = (n: number) => makeId("chg", String(n).padStart(26, "0"));
const A = chg(1);
const B = chg(2);
const subject = SubjectKey.make("authz.permission-evaluation");

const premiseA: HeldPremise = {
  holder: A,
  proposition: { subject, predicate: "freshness", relation: "at-most", value: "per-request", gloss: "revocation takes effect on the next request" },
};
const cacheOf = (value: string, s = subject): DerivedEffect => ({
  proposition: { subject: s, predicate: "freshness", relation: "is", value },
  method: "clef",
  evidenceClass: "opinion",
  p: 0.93,
  anchors: [],
  declared: false,
});
const intentB: Intent = {
  revision: 1,
  goal: "speed up permission checks",
  footprint: [{ path: Glob.make("src/authz/**"), op: "edit" }],
  premises: [],
  declaredEffects: [],
};
const touched = [{ path: Glob.make("src/authz/cache.ts"), op: "edit" as const }];

const run = (n: number): ProbeCell[] => [
  { world: "trunk", run: n, outcome: "pass" },
  { world: "A", run: n, outcome: "pass" },
  { world: "B", run: n, outcome: "n/a" },
  { world: "AB", run: n, outcome: "fail" },
];
const step = (id: string, extra: Partial<StepSpec>): StepSpec => ({
  id,
  version: contentHashOf({ id }),
  kind: "deterministic",
  evidenceCeiling: "proof",
  appliesTo: { paths: [], subjects: [] },
  reads: [],
  outcomes: ["pass", "fail", "abstain"],
  mayskip: [],
  overrides: [],
  budget: { usd: 0.001, cpuMs: 100, tokens: 0 },
  determinism: "deterministic",
  suite: false,
  optional: false,
  ...extra,
});

describe("S-1: agents collide on beliefs", () => {
  it("[demo.s1-contradiction] B's derived per-session cache contradicts A's premise and is a silent retraction that opens a conflict", () => {
    const comparison = compare(premiseA.proposition, cacheOf("per-session").proposition);
    const findings = drift(B, intentB, touched, [cacheOf("per-session")], [premiseA], []);
    const reached = fallout(B, cacheOf("per-session"), [premiseA], []);
    show("compare", comparison);
    show("drift", findings.map((f) => ({ class: f.drift.class, severity: f.drift.severity, blocks: f.blocks, opensConflict: f.opensConflict })));
    show("fallout", reached.map((f) => (f._tag === "conflict" ? { conflict: f.kind, silentRetraction: f.silentRetraction } : f._tag)));
    expect(comparison.outcome).toBe("contradicts");
    expect(findings.map((f) => [f._tag, f.blocks, f.opensConflict])).toEqual([["silent-retraction", false, true]]);
    expect(reached.map((f) => (f._tag === "conflict" ? f.silentRetraction : f._tag))).toEqual([true]);
  });

  it("[demo.s1-decoys] a compatible cache on the same subject stays compatible, and a sibling subject is only proximity", () => {
    const decoy = cacheOf("per-request");
    const sibling = cacheOf("per-session", SubjectKey.make("authz.audit-log"));
    show("decoy compare", compare(premiseA.proposition, decoy.proposition));
    show("decoy fallout", fallout(B, decoy, [premiseA], []).map((f) => f._tag));
    show("sibling fallout", fallout(B, sibling, [premiseA], []).map((f) => (f._tag === "notify" ? f.reason : f._tag)));
    expect(compare(premiseA.proposition, decoy.proposition).outcome).toBe("compatible");
    expect(fallout(B, decoy, [premiseA], []).map((f) => f._tag)).toEqual(["suspect"]);
    expect(drift(B, intentB, touched, [decoy], [premiseA], []).map((f) => [f._tag, f.blocks])).toEqual([["undeclared-effect", false]]);
    expect(compare(premiseA.proposition, sibling.proposition).outcome).toBe("unrelated");
    expect(fallout(B, sibling, [premiseA], []).map((f) => (f._tag === "notify" ? f.reason : f._tag))).toEqual(["sibling-subject"]);
  });

  it("[demo.s1-preflight] had B declared the cache up front, preflight shows the contradiction before any code exists", () => {
    const honest: Intent = { ...intentB, declaredEffects: [cacheOf("per-session").proposition] };
    const liveA = { id: A, intent: { revision: 1, goal: "owners can revoke collaborators", footprint: [{ path: Glob.make("src/authz/**"), op: "edit" as const }], premises: [premiseA.proposition] }, derived: [] };
    const seen = exposure(B, honest, [liveA]);
    show("preflight", { neighbours: seen.neighbours.map((n) => [n.changeId, n.overlap]), contradictions: seen.contradictions.length });
    expect(seen.neighbours.map((n) => n.changeId)).toEqual([A]);
    expect(seen.contradictions.map((c) => c.holder)).toEqual([A]);
    const bets = rankBets([premiseA], [], () => Result.getOrThrow(probeCost(0.002)));
    show("bets", bets.map((b) => ({ holder: b.premise.holder, blast: b.blast })));
    expect(bets.map((b) => b.blast)).toEqual([2]);
  });

  it("[demo.s1-guard] the drafted probe discriminates on forge-lite's matrix, becomes G-1, and B bounces until it keeps revocation working", () => {
    const admission = admit([...run(1), ...run(2), ...run(3)]);
    show("admission", admission);
    expect(admission).toEqual({ _tag: "admitted", runs: 3 });

    const steps = [step("forge-lite.suite", { suite: true }), step("G-1", { kind: "probe" })];
    const plan = Result.getOrThrow(
      compile(
        { commit: base, steps, flow: { _tag: "seq", exitOn: "fail", items: [{ _tag: "step", step: "forge-lite.suite" }, { _tag: "step", step: "G-1" }] } },
        { baseCommit: base, touchedPaths: ["src/authz/cache.ts"], subjects: [subject], facts: factClasses },
        emptyDefaults,
      ),
    );
    const result = (stepId: string, outcome: string) =>
      coerce(plan, { stepId, outcome, evidenceClass: "proof", tier: plan.steps.find((s) => s.id === stepId)!.tier, durationMs: 5 });
    const bounced = Result.getOrThrow(verdict(plan, { results: [result("forge-lite.suite", "pass"), result("G-1", "fail")] }, "verdict/1"));
    const revised = Result.getOrThrow(verdict(plan, { results: [result("forge-lite.suite", "pass"), result("G-1", "pass")] }, "verdict/1"));
    show("verdict B (cache without invalidation)", { outcome: bounced.outcome, evidence: bounced.evidence.map((e) => [e.stepId, e.outcome]) });
    show("verdict B' (cache invalidated on revoke)", { outcome: revised.outcome });
    expect([bounced.outcome, bounced.evidence.map((e) => e.stepId)]).toEqual(["bounce", ["G-1"]]);
    expect(revised.outcome).toBe("land");
    expect(plan.steps.map((s) => [s.id, s.tier.tier])).toEqual([["forge-lite.suite", 2], ["G-1", 1]]);
  });
});
