/**
 * What crosses the wire decodes only in the shapes Keel commits to: finite
 * numbers (JSON turns NaN and ±Infinity into null), and records whose fields
 * depend on each other.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ChangeBounced,
  DecisionModelEffect,
  declaredEffect,
  DerivedEffect,
  InvalidProbeCost,
  type JudgedEffect,
  PlanCompiled,
  Proposition,
} from "../../src/domain/coordination/index.ts";
import { TrunkAdvanced } from "../../src/domain/integration/index.ts";
import { CommitSha, InstantSchema, makeId } from "../../src/domain/kernel/index.ts";
import { Tenet, TenetEstablished } from "../../src/domain/memory/index.ts";
import {
  ConflictSuspected,
  GateThreshold,
  GuardFailed,
  OpinionAsk,
  StepResult,
  SuspectEvidence,
  suspectEvidence,
  VerdictIssued,
  VerificationPlan,
  WorldCheckRan,
} from "../../src/domain/verification/index.ts";
import { fc } from "../support/fast-check.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const decodes =
  (schema: Schema.Codec<unknown>) =>
  (value: unknown): boolean => {
    try {
      Schema.decodeUnknownSync(schema)(value);
      return true;
    } catch {
      return false;
    }
  };

const encodes =
  (schema: Schema.Codec<unknown>) =>
  (value: unknown): boolean => {
    try {
      Schema.encodeUnknownSync(schema)(value);
      return true;
    } catch {
      return false;
    }
  };

/** Each numeric field that crosses the wire, with a finite value it accepts. */
const NUMBERS: readonly (readonly [string, Schema.Codec<unknown>, number])[] = [
  ["Instant", InstantSchema, 1_760_000_000_000],
  ["DerivedEffect.p", DecisionModelEffect.fields.p, 0.6],
  ["PlanCompiled.costEstimate", PlanCompiled.fields.costEstimate, 12.5],
  ["Proposition.value", Proposition.fields.value, 300],
  ["InvalidProbeCost.cost", InvalidProbeCost.fields.cost, -1],
  ["Tenet.value", Tenet.fields.value, 300],
  ["TenetEstablished.value", TenetEstablished.fields.value, 300],
  ["VerificationPlan.costEstimate", VerificationPlan.fields.costEstimate, 12.5],
  ["StepResult.durationMs", StepResult.fields.durationMs, 5],
  ["OpinionAsk.violating", OpinionAsk.fields.violating, 0.6],
  ["OpinionAsk.compatible", OpinionAsk.fields.compatible, 0.3],
  ["GateThreshold.raise", GateThreshold.fields.raise, 0.65],
  ["GateThreshold.floor", GateThreshold.fields.floor, 0.65],
  ["WorldCheckRan.run", WorldCheckRan.fields.run, 1],
  ["TrunkAdvanced.height", TrunkAdvanced.fields.height, 3],
];
const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

const CONFLICT = makeId("cfl", ulid(1));
const CHANGE = makeId("chg", ulid(2));
const check = (outcome: string, extra: object = {}) => ({
  _tag: "WorldCheckRan",
  conflictId: CONFLICT,
  world: "AB",
  check: `suite:${CHANGE}`,
  run: 1,
  outcome,
  ...extra,
});

const GUARD = makeId("grd", ulid(3));
const guardFailed = (extra: object) => ({
  _tag: "GuardFailed",
  guardId: GUARD,
  world: "AB",
  ...extra,
});
const BATCH = { batchId: makeId("bat", ulid(4)) };
const BY_VERDICT = { verdictId: makeId("vrd", ulid(6)) };
const BY_CONFLICT = { conflictId: makeId("cfl", ulid(7)) };
const bounce = (cause: object) => ({
  _tag: "ChangeBounced",
  changeId: CHANGE,
  ...cause,
  reasons: ["a must premise is contradicted"],
});
const CANDIDATE = { candidateId: makeId("cnd", ulid(5)) };

const ANCHOR = { path: "src/authz/cache.ts", commit: CommitSha.make("c".repeat(40)) };
const effect = (fields: object) => ({
  proposition: {
    subject: "authz.permission-evaluation",
    predicate: "freshness",
    relation: "is",
    value: "per-session",
  },
  anchors: [ANCHOR],
  declared: false,
  ...fields,
});

const HOLDER = makeId("chg", ulid(8));
const CLAIM = Schema.decodeUnknownSync(Proposition)({
  subject: "authz.permission-evaluation",
  predicate: "freshness",
  relation: "is",
  value: "per-session",
});
/** A semantic conflict whose effect carries these extra fields. */
const suspected = (extra: object) => ({
  _tag: "ConflictSuspected",
  conflictId: CONFLICT,
  kind: "semantic",
  parties: [CHANGE, HOLDER],
  premise: { holder: HOLDER, proposition: CLAIM },
  effect: { changeId: CHANGE, proposition: CLAIM, ...extra },
});
/** A ConflictSuspected as it comes back from the log: decoded, encoded, through JSON, decoded. */
const suspectedBack = (extra: object): typeof ConflictSuspected.Type =>
  Schema.decodeUnknownSync(ConflictSuspected)(
    JSON.parse(
      JSON.stringify(
        Schema.encodeSync(ConflictSuspected)(
          Schema.decodeUnknownSync(ConflictSuspected)(suspected(extra)),
        ),
      ),
    ),
  );

/**
 * Every way a suspect effect may be known, written out apart from the schema.
 * With no method it is the agent's own claim. With one, Keel derived it, and
 * the agent's declared effects may or may not have spoken for it.
 */
const LAWFUL_EVIDENCE: readonly object[] = [
  { declared: true, evidenceClass: "testimony" },
  { declared: true, method: "extractor", evidenceClass: "ruling" },
  { declared: false, method: "extractor", evidenceClass: "ruling" },
  { declared: true, method: "clef", evidenceClass: "opinion" },
  { declared: false, method: "clef", evidenceClass: "opinion" },
  { declared: true, method: "code-model", evidenceClass: "opinion" },
  { declared: false, method: "code-model", evidenceClass: "opinion" },
];
/** Every evidence the wire could carry: declared or not, by no method or one of three, in each class. */
const EVERY_EVIDENCE: readonly object[] = [true, false].flatMap((declared) =>
  [undefined, "extractor", "clef", "code-model"].flatMap((method) =>
    ["proof", "ruling", "testimony", "opinion"].map((evidenceClass) => ({
      declared,
      ...(method === undefined ? {} : { method }),
      evidenceClass,
    })),
  ),
);
/** Whether two flat records hold the same fields with the same values, in any order. */
const sameRecord = (a: object, b: object): boolean =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([key, value]) => Reflect.get(b, key) === value);
const isLawfulEvidence = (evidence: object): boolean =>
  LAWFUL_EVIDENCE.some((lawful) => sameRecord(lawful, evidence));

/** A derived effect as fallout holds it, decoded from its wire form. */
const derived = (fields: object): JudgedEffect =>
  Schema.decodeUnknownSync(DerivedEffect)(effect(fields));

const nextActionArb = fc.record(
  {
    kind: fc.constantFrom("call" as const, "wait" as const, "read" as const, "escalate" as const),
    title: fc.string({ minLength: 1, maxLength: 12 }),
    operationId: fc.constantFrom("revise", "submit", "adopt"),
    args: fc.dictionary(fc.string({ maxLength: 6 }), fc.oneof(fc.string(), fc.integer())),
  },
  { requiredKeys: ["kind", "title"] },
);
const verdictArb = fc.record(
  {
    verdictId: fc.constant(makeId("vrd", ulid(6))),
    subject: fc.constantFrom(CHANGE, makeId("bat", ulid(7))),
    outcome: fc.constantFrom("land" as const, "bounce" as const, "park" as const),
    evidence: fc.array(fc.string(), { maxLength: 3 }),
    nextActions: fc.array(nextActionArb, { minLength: 1, maxLength: 3 }),
  },
  { requiredKeys: ["verdictId", "subject", "outcome", "evidence"] },
);
const throughJson = (verdict: typeof VerdictIssued.Type): typeof VerdictIssued.Type =>
  Schema.decodeUnknownSync(VerdictIssued)(
    JSON.parse(JSON.stringify(Schema.encodeSync(VerdictIssued)(verdict))),
  );

describe("the wire", () => {
  it("[wire.finite] every number that crosses the wire refuses NaN and ±Infinity at decode", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NUMBERS),
        fc.constantFrom(...NON_FINITE),
        ([, schema, ok], bad) => decodes(schema)(ok) && !decodes(schema)(bad),
      ),
    );
    const refusing = NUMBERS.filter(([, schema]) =>
      NON_FINITE.every((bad) => !decodes(schema)(bad)),
    );
    expect(refusing.map(([name]) => name)).toEqual(NUMBERS.map(([name]) => name));
  });

  it("[events.world-check-na-reason] a suite cell that did not apply says why; one that ran need not", () => {
    const decodesCheck = decodes(WorldCheckRan);
    expect(decodesCheck(check("n/a"))).toBe(false);
    expect(decodesCheck(check("n/a", { reason: "no fixture in A-noop" }))).toBe(true);
    expect(decodesCheck(check("pass", { counts: { passed: 12, failed: 0, skipped: 1 } }))).toBe(
      true,
    );
    expect(decodesCheck(check("fail", { run: 4 }))).toBe(false);
    expect(decodesCheck(check("pass", { check: "probe:prb_1" }))).toBe(false);
  });

  it("[events.world-check-id] a suite cell is the project's suite on trunk or a change's own, and nothing else", () => {
    const decodesCheck = decodes(WorldCheckRan);
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant({ id: "suite:trunk", ok: true }),
          fc.nat({ max: 999 }).map((n) => ({ id: `suite:${makeId("chg", ulid(n))}`, ok: true })),
          fc
            .constantFrom(
              "suite:",
              "trunk",
              "suite:trunks",
              "suite:trunk:x",
              `suite:${makeId("prj", ulid(1))}`,
              `suite:${CHANGE}x`,
              `probe:${CHANGE}`,
            )
            .map((id) => ({ id, ok: false })),
        ),
        ({ id, ok }) => decodesCheck(check("pass", { check: id })) === ok,
      ),
    );
    expect(decodesCheck(check("pass", { check: "suite:trunk" }))).toBe(true);
    expect(decodesCheck(check("pass", { check: `suite:${CHANGE}` }))).toBe(true);
  });

  it("[events.guard-failed-shape] a guard fails against a change, or against a batch and its candidate", () => {
    const decodesGuard = decodes(GuardFailed);
    expect(decodesGuard(guardFailed({ changeId: CHANGE }))).toBe(true);
    expect(decodesGuard(guardFailed({ ...BATCH, ...CANDIDATE }))).toBe(true);
    expect(decodesGuard(guardFailed({}))).toBe(false);
    expect(decodesGuard(guardFailed(BATCH))).toBe(false);
    expect(decodesGuard(guardFailed(CANDIDATE))).toBe(false);
  });

  it("[events.bounce-cause] a bounce names exactly one cause, its verdict or its conflict, and that cause survives the wire", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (verdict, conflict) => {
        const sent = bounce({ ...(verdict ? BY_VERDICT : {}), ...(conflict ? BY_CONFLICT : {}) });
        if (verdict === conflict) return !decodes(ChangeBounced)(sent);
        const back = Schema.decodeUnknownSync(ChangeBounced)(
          JSON.parse(
            JSON.stringify(
              Schema.encodeSync(ChangeBounced)(Schema.decodeUnknownSync(ChangeBounced)(sent)),
            ),
          ),
        );
        return (
          back.verdictId === (verdict ? BY_VERDICT.verdictId : undefined) &&
          back.conflictId === (conflict ? BY_CONFLICT.conflictId : undefined)
        );
      }),
    );
    expect(decodes(ChangeBounced)(bounce(BY_CONFLICT))).toBe(true);
    expect(decodes(ChangeBounced)(bounce({ ...BY_VERDICT, ...BY_CONFLICT }))).toBe(false);
    expect(decodes(ChangeBounced)(bounce({}))).toBe(false);
  });

  it("[derivation.record-shape] a derived effect's method fixes its evidence class and probability: an extractor rules and carries no p, a decision model is opinion with p in [0, 1]", () => {
    const decodesEffect = decodes(DerivedEffect);
    expect(decodesEffect(effect({ method: "extractor", evidenceClass: "ruling" }))).toBe(true);
    expect(decodesEffect(effect({ method: "clef", evidenceClass: "opinion", p: 0.603 }))).toBe(
      true,
    );
    expect(decodesEffect(effect({ method: "code-model", evidenceClass: "opinion" }))).toBe(true);
    const refused = [
      effect({ method: "extractor", evidenceClass: "proof" }),
      effect({ method: "clef", evidenceClass: "opinion" }),
      effect({ method: "clef", evidenceClass: "ruling", p: 0.9 }),
      effect({ method: "clef", evidenceClass: "opinion", p: 1.2 }),
      effect({ method: "code-model", evidenceClass: "opinion", p: -0.1 }),
      effect({ method: "code-model", evidenceClass: "testimony" }),
      { ...effect({ method: "extractor", evidenceClass: "ruling" }), anchors: [] },
    ];
    expect(refused.filter(decodesEffect)).toEqual([]);
    // An extractor has no probability: one given is dropped at decode, never carried.
    const ruled = Schema.decodeUnknownSync(DerivedEffect)(
      effect({ method: "extractor", evidenceClass: "ruling", p: 0.9 }),
    );
    expect(ruled).not.toHaveProperty("p");
  });

  it("[events.suspect-evidence-shape] a suspect effect's evidence has no method and is declared testimony, or has a method that fixes its class, and survives the wire; an effect without it stays without", () => {
    expect(EVERY_EVIDENCE).toHaveLength(32);
    const taken = EVERY_EVIDENCE.filter((evidence) =>
      decodes(ConflictSuspected)(suspected({ evidence })),
    );
    expect(taken).toEqual(EVERY_EVIDENCE.filter(isLawfulEvidence));
    expect(taken).toHaveLength(LAWFUL_EVIDENCE.length);
    // Fallout writes the event, it does not read it: encoding refuses what decoding does.
    const written = EVERY_EVIDENCE.filter((evidence) =>
      encodes(ConflictSuspected)(suspected({ evidence })),
    );
    expect(written).toEqual(EVERY_EVIDENCE.filter(isLawfulEvidence));

    for (const evidence of LAWFUL_EVIDENCE)
      expect(suspectedBack({ evidence }).effect?.evidence).toStrictEqual(evidence);

    // An event written before the field decodes, and gains nothing on the way.
    const older = suspectedBack({});
    expect(older.effect).toStrictEqual({ changeId: CHANGE, proposition: CLAIM });
  });

  it("[events.suspect-evidence-of-judged] the evidence of a judged effect is lawful and says what the effect says: its method, its class, and whether it was declared", () => {
    const judged: readonly JudgedEffect[] = [
      declaredEffect(CLAIM),
      ...[true, false].flatMap((declared) => [
        derived({ declared, method: "extractor", evidenceClass: "ruling" }),
        derived({ declared, method: "clef", evidenceClass: "opinion", p: 0.6 }),
        derived({ declared, method: "code-model", evidenceClass: "opinion" }),
      ]),
    ];
    const evidence = judged.map(suspectEvidence);
    expect(evidence).toStrictEqual([
      { declared: true, evidenceClass: "testimony" },
      { declared: true, method: "extractor", evidenceClass: "ruling" },
      { declared: true, method: "clef", evidenceClass: "opinion" },
      { declared: true, method: "code-model", evidenceClass: "opinion" },
      { declared: false, method: "extractor", evidenceClass: "ruling" },
      { declared: false, method: "clef", evidenceClass: "opinion" },
      { declared: false, method: "code-model", evidenceClass: "opinion" },
    ]);
    expect(evidence.filter((one) => !decodes(SuspectEvidence)(one))).toEqual([]);
    // Between them they are every lawful evidence: nothing fallout judges is left unsayable.
    expect(
      LAWFUL_EVIDENCE.filter((lawful) => !evidence.some((one) => sameRecord(lawful, one))),
    ).toEqual([]);
  });

  it("[events.verdict-next-actions] a verdict's next actions, set by its issuer, survive the wire unchanged; a verdict without them stays without", () => {
    let carried = 0;
    fc.assert(
      fc.property(verdictArb, (fields) => {
        const verdict = VerdictIssued.make(fields);
        const back = throughJson(verdict);
        if (fields.nextActions !== undefined) carried++;
        return JSON.stringify(back.nextActions) === JSON.stringify(fields.nextActions);
      }),
    );
    expect(carried).toBeGreaterThan(0);
    // A composition refusal names the remedy, which the Change DO copies onto its bounce.
    const refused = throughJson(
      VerdictIssued.make({
        verdictId: makeId("vrd", ulid(8)),
        subject: makeId("bat", ulid(9)),
        outcome: "bounce",
        evidence: ["composition-refused: both sides edit src/a.ts"],
        nextActions: [{ kind: "call", title: "Rebase onto trunk", operationId: "revise" }],
      }),
    );
    expect(refused.nextActions).toEqual([
      { kind: "call", title: "Rebase onto trunk", operationId: "revise" },
    ]);
  });
});
