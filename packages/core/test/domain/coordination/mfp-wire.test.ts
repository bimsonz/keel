import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkMessages, loadWire, type Profile } from "@bimsonz/mfp/profile";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  citationOfMfp,
  citationToMfp,
  effectOfMfp,
  effectToMfp,
  MfpPremiseProposition,
  type MfpEffectProposition,
  type Proposition,
  premiseOfMfp,
  premiseToMfp,
  readClaim,
  retractedBy,
  SubjectKey,
  type Untellable,
} from "../../../src/domain/coordination/index.ts";
import { CommitSha, makeId } from "../../../src/domain/kernel/index.ts";
import { KEEL_MFP_PROFILE } from "../../../src/domain/memory/index.ts";
import { citationArb, wirePropositionArb } from "../../arbitraries/coordination.ts";
import { fc } from "../../support/fast-check.ts";

const PROPERTY_TIMEOUT = 60_000;

/** Keel's MFP profile, as the spec publishes it. */
const PROFILE: Profile = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../../../packages/spec/mfp/keel.profile.json"),
    "utf8",
  ),
);

const SESSION = makeId("ses", "0".repeat(26));
const COMMIT = CommitSha.make("a".repeat(40));
const WORKING = CommitSha.make("b".repeat(40));
const subject = (s: string) => SubjectKey.make(s);

const premiseArb = wirePropositionArb("premise");
const effectArb = wirePropositionArb("effect");

/** The same proposition with a relation its predicate does not read on. */
const spoiled = (p: Proposition): Proposition => ({
  ...p,
  relation: p.predicate === "ordering" ? "at-most" : "before",
});

/** Each stored proposition, and some that do not read. */
const storedArb = (arb: fc.Arbitrary<Proposition>) =>
  fc.oneof({ weight: 9, arbitrary: arb }, { weight: 1, arbitrary: arb.map(spoiled) });

/** What a stored proposition comes back as: a unit off a bound, and an effect's strength, are not told. */
const asTold = (p: Proposition, role: "premise" | "effect"): Proposition => {
  const { unit, strength, ...rest } = p;
  return {
    ...rest,
    ...(unit === undefined || p.predicate !== "bound" ? {} : { unit }),
    ...(strength === undefined || role === "effect" ? {} : { strength }),
  };
};

/** A 0.2 shape premise: an object with string fields of these names. */
const shapeOf = (fields: readonly string[]) =>
  Schema.decodeUnknownSync(MfpPremiseProposition)({
    subject: "authz.grant",
    predicate: "shape",
    relation: "is",
    value: {
      type: "object",
      fields: fields.map((name) => ({ name, shape: { type: "string" }, optional: false })),
    },
  });

const told = <A>(r: Result.Result<A, Untellable>): A => {
  if (Result.isFailure(r)) throw new Error(`untellable: ${r.failure.reason}, ${r.failure.detail}`);
  return r.success;
};
const why = <A>(r: Result.Result<A, Untellable>): string | undefined =>
  Result.isFailure(r) ? r.failure.reason : undefined;

describe("the MFP 0.2 wire", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[mfp-wire.premise-round-trip] a stored premise is told in 0.2 exactly where it reads as one, and comes back as it was stored", () => {
    fc.assert(
      fc.property(storedArb(premiseArb), (p) => {
        // What comes back, or why it was not told: unreadable, exactly where it does not read.
        const back = Result.flatMap(premiseToMfp(p), (m) => premiseOfMfp(m));
        expect(Result.isSuccess(back) ? back.success : why(back)).toEqual(
          Result.isSuccess(readClaim(p, "premise")) ? asTold(p, "premise") : "unreadable",
        );
      }),
    );
    // Writers go in the order they were written, which is not always sorted.
    const writers: Proposition = {
      subject: subject("authz.grant"),
      predicate: "authority",
      relation: "is",
      value: "carol,alice",
    };
    expect(told(premiseOfMfp(told(premiseToMfp(writers))))).toEqual(writers);
  });

  it("[mfp-wire.effect-round-trip] a stored effect, the invalidation form included, is told in 0.2 exactly where it reads, and comes back as it was stored", () => {
    let invalidations = 0;
    fc.assert(
      fc.property(storedArb(effectArb), (p) => {
        const back = Result.flatMap(effectToMfp(p), (m) => effectOfMfp(m));
        if (Result.isSuccess(back) && String(p.value).includes("invalidated-on"))
          invalidations += 1;
        expect(Result.isSuccess(back) ? back.success : why(back)).toEqual(
          Result.isSuccess(readClaim(p, "effect")) ? asTold(p, "effect") : "unreadable",
        );
      }),
    );
    expect(invalidations).toBeGreaterThan(0);
    // Writers go in the order they were written, which is not always sorted.
    const writers: Proposition = {
      subject: subject("authz.grant"),
      predicate: "authority",
      relation: "at-most",
      value: "carol,alice",
    };
    expect(told(effectToMfp(writers))).toMatchObject({ value: ["carol", "alice"] });
    expect(told(effectOfMfp(told(effectToMfp(writers))))).toEqual(writers);
    // A bound with no unit goes as unit 1, and comes back with none.
    const unitless: Proposition = {
      subject: subject("api.latency"),
      predicate: "bound",
      relation: "at-most",
      value: 3,
    };
    expect(told(effectToMfp(unitless))).toMatchObject({ value: 3, unit: "1" });
    expect(told(effectOfMfp(told(effectToMfp(unitless))))).toEqual(unitless);
  });

  it("[mfp-wire.from-mfp] what Keel tells in 0.2 comes back through Keel unchanged, and an anchor with no commit takes the working one given", () => {
    fc.assert(
      fc.property(premiseArb, effectArb, (p, e) => {
        const premise = told(premiseToMfp(p));
        expect(told(premiseToMfp(told(premiseOfMfp(premise))))).toEqual(premise);
        const effect = told(effectToMfp(e));
        expect(told(effectToMfp(told(effectOfMfp(effect))))).toEqual(effect);
        // The same anchors with no commit stand for the working commit given.
        const loose = {
          ...premise,
          ...(premise.anchors === undefined
            ? {}
            : { anchors: premise.anchors.map(({ commit: _commit, ...a }) => a) }),
        };
        expect(told(premiseOfMfp(loose, { working: COMMIT }))).toEqual(told(premiseOfMfp(premise)));
      }),
    );
  });

  it("[mfp-wire.untellable] what one side has no form for, or does not read, is refused each way with its reason, never repaired", () => {
    // Into Keel: a tool result, an anchor with no commit and none given, a ref that is not <session>/<seq>.
    expect(why(citationOfMfp({ kind: "tool-result", ref: "call-7" }))).toBe("tool-result");
    expect(why(citationOfMfp({ kind: "anchor", path: "src/a.ts" }))).toBe("anchor-commit");
    expect(told(citationOfMfp({ kind: "anchor", path: "src/a.ts" }, { working: WORKING }))).toEqual(
      { _tag: "anchor", anchor: { path: "src/a.ts", commit: WORKING } },
    );
    for (const ref of [`${SESSION}/-1`, `${SESSION}/01`, SESSION, `${SESSION}/1/2`, "ses_x/1"])
      expect({ ref, why: why(citationOfMfp({ kind: "message", ref })) }).toEqual({
        ref,
        why: "message-ref",
      });
    expect(told(citationOfMfp({ kind: "message", ref: `${SESSION}/0` }))).toEqual({
      _tag: "message",
      session: SESSION,
      seq: 0,
    });

    // Into Keel: a shape repeating or reserving a field name; 0.2's forms that pass its schema and do not read.
    expect(why(premiseOfMfp(shapeOf(["id", "id"])))).toBe("shape-name");
    expect(why(premiseOfMfp(shapeOf(["__proto__"])))).toBe("shape-name");
    expect(told(premiseOfMfp(shapeOf(["id", "role"]))).value).toBe(
      '{"_tag":"object","fields":{"id":{"shape":{"_tag":"string"},"optional":false},"role":{"shape":{"_tag":"string"},"optional":false}}}',
    );
    const invalidation = (value: string): MfpEffectProposition => ({
      subject: subject("authz.cache"),
      predicate: "freshness",
      relation: "is",
      value,
    });
    expect(why(effectOfMfp(invalidation("static invalidated-on role.changed,grant.revoked")))).toBe(
      "unreadable",
    );
    expect(
      why(effectOfMfp(invalidation("static invalidated-on grant.revoked,grant.revoked"))),
    ).toBe("unreadable");
    expect(
      told(effectOfMfp(invalidation("static invalidated-on grant.revoked,role.changed"))),
    ).toEqual(invalidation("static invalidated-on grant.revoked,role.changed"));
    expect(
      why(
        premiseOfMfp({
          subject: subject("check"),
          predicate: "ordering",
          relation: "before",
          value: subject("check"),
        }),
      ),
    ).toBe("unreadable");
    expect(
      why(
        premiseOfMfp({
          subject: subject("authz.check"),
          predicate: "presence",
          relation: "is",
          value: true,
          scope: "env:prod;env:staging",
        }),
      ),
    ).toBe("unreadable");
    // A premise in the invalidation form is not a 0.2 premise at all.
    expect(
      Schema.is(MfpPremiseProposition)({
        ...invalidation("static invalidated-on a.b"),
        strength: "must",
      }),
    ).toBe(false);

    // Out of Keel: a stored proposition that does not read, a premise relying on an invalidation,
    // a writer with a space, an empty field or opaque name, a unit with a space.
    const stored = (p: Partial<Proposition>): Proposition => ({
      subject: subject("authz.check"),
      predicate: "presence",
      relation: "is",
      value: true,
      ...p,
    });
    expect(why(premiseToMfp(stored({ relation: "before" })))).toBe("unreadable");
    expect(
      why(premiseToMfp(stored({ predicate: "freshness", value: "static invalidated-on a.b" }))),
    ).toBe("unreadable");
    expect(why(premiseToMfp(stored({ predicate: "authority", value: "alice, bob smith" })))).toBe(
      "writer",
    );
    expect(
      why(
        premiseToMfp(
          stored({
            predicate: "shape",
            value: '{"_tag":"object","fields":{"":{"shape":{"_tag":"string"},"optional":false}}}',
          }),
        ),
      ),
    ).toBe("shape-name");
    expect(
      why(premiseToMfp(stored({ predicate: "shape", value: '{"_tag":"opaque","name":""}' }))),
    ).toBe("shape-name");
    expect(
      why(premiseToMfp(stored({ predicate: "bound", relation: "at-most", value: 3, unit: "m s" }))),
    ).toBe("unit");
    // A blank scope is everywhere, told with none; an effect's strength and a unit off a bound are dropped.
    expect(told(premiseToMfp(stored({ scope: "  " })))).not.toHaveProperty("scope");
    expect(told(effectToMfp(stored({ strength: "should", unit: "ms" })))).toEqual({
      subject: "authz.check",
      predicate: "presence",
      relation: "is",
      value: true,
    });
  });

  it("[mfp-wire.citations] a citation Keel holds goes to 0.2 and comes back unchanged, a message as <session>/<seq>", () => {
    fc.assert(
      fc.property(citationArb, (c) => {
        expect(told(citationOfMfp(citationToMfp(c)))).toEqual(c);
      }),
    );
    expect(citationToMfp({ _tag: "message", session: SESSION, seq: 7 })).toEqual({
      kind: "message",
      ref: `${SESSION}/7`,
    });
    expect(
      citationToMfp({ _tag: "anchor", anchor: { path: "src/a.ts", symbol: "f", commit: COMMIT } }),
    ).toEqual({ kind: "anchor", path: "src/a.ts", symbol: "f", commit: COMMIT });
    expect(citationToMfp({ _tag: "record", id: "run/42" })).toEqual({
      kind: "record",
      ref: "run/42",
    });
  });

  it("[mfp-wire.retracted-by] a 0.2 premise retracts the stored premise Keel told as it, an older spelling included, and no other", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(premiseArb, {
          minLength: 1,
          maxLength: 4,
          selector: (p) => JSON.stringify(p),
        }),
        (premises) => {
          for (const p of premises) {
            const found = retractedBy(premises, told(premiseToMfp(p)));
            expect(found === undefined ? undefined : premiseToMfp(found)).toEqual(premiseToMfp(p));
          }
        },
      ),
    );
    // Spellings stored before the wire was 0.2: a bound's empty unit, writers with spaces, a scope out of order.
    const plain: Proposition = {
      subject: subject("authz.check"),
      predicate: "presence",
      relation: "is",
      value: true,
      scope: "tenant:t1 ; env:prod",
    };
    const legacy: Proposition[] = [
      {
        subject: subject("api.latency"),
        predicate: "bound",
        relation: "at-most",
        value: 3,
        unit: "",
      },
      {
        subject: subject("authz.grant"),
        predicate: "authority",
        relation: "is",
        value: "alice, bob",
      },
      plain,
    ];
    for (const p of legacy) expect(retractedBy(legacy, told(premiseToMfp(p)))).toBe(p);
    // Retracting with strength must said outright finds a premise stored with none.
    expect(retractedBy(legacy, { ...told(premiseToMfp(plain)), strength: "must" })).toBe(plain);
    expect(
      retractedBy(legacy, { ...told(premiseToMfp(plain)), strength: "should" }),
    ).toBeUndefined();
    // A scope 0.2 writes in another order is the same scope.
    expect(retractedBy(legacy, { ...told(premiseToMfp(plain)), scope: "tenant:t1;env:prod" })).toBe(
      plain,
    );
  });

  it("[mfp.spec-agrees] every premise and effect Keel tells passes MFP 0.2's own schema in a premise and an intent message under Keel's profile", () => {
    // Every run's messages are checked in one call: MFP's checker compiles its schemas each time it is called.
    const messages: [string, unknown][] = [];
    fc.assert(
      fc.property(premiseArb, effectArb, (p, e) => {
        const premise = told(premiseToMfp(p));
        const effect = told(effectToMfp(e));
        const run = String(messages.length / 2).padStart(4, "0");
        messages.push(
          [`premise ${run}`, { mfp: "0.2", profile: KEEL_MFP_PROFILE, kind: "premise", premise }],
          [
            `intent ${run}`,
            {
              mfp: "0.2",
              profile: KEEL_MFP_PROFILE,
              kind: "intent",
              goal: "keep grants fresh",
              premises: [premise],
              declaredEffects: [effect],
            },
          ],
        );
      }),
    );
    const problems = checkMessages(loadWire(), PROFILE, messages);
    expect(
      problems.map((problem) => ({
        problem,
        message: messages.find(([name]) => problem.includes(name))?.[1],
      })),
    ).toEqual([]);
    expect(messages.length).toBeGreaterThan(100);
  });
});
