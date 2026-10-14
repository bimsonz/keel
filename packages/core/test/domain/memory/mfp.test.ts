import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkMessages, loadWire, type Profile } from "@bimsonz/mfp/profile";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  citationToMfp,
  effectToMfp,
  FootprintEntry,
  premiseToMfp,
  type Untellable,
} from "../../../src/domain/coordination/index.ts";
import { EvidenceClass, makeId } from "../../../src/domain/kernel/index.ts";
import {
  KEEL_MFP_PROFILE,
  KeelRecord,
  MfpIntent,
  MfpMessage,
  MfpObservation,
  MfpStance,
  RecordAuthor,
} from "../../../src/domain/memory/index.ts";
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

const ulid = (n: number): string => String(n).padStart(26, "0");
const DECISION = makeId("dec", ulid(1));
const CHANGE = makeId("chg", ulid(1));
const GUARD = `grd_${ulid(1)}`;
const AT = "2026-10-14T00:57:21.555Z";

const told = <A>(r: Result.Result<A, Untellable>): A => {
  if (Result.isFailure(r)) throw new Error(`untellable: ${r.failure.reason}, ${r.failure.detail}`);
  return r.success;
};

/** A vocabulary Keel's profile closes. */
const vocabulary = (name: "verdict.outcome" | "observation.category"): string[] => {
  const words = PROFILE.vocabularies?.[name] ?? [];
  if (words.length === 0) throw new Error(`Keel's profile does not close ${name}`);
  return words;
};

// Propositions and citations are told by Keel's own conversions. The values of
// MFP's closed members come from core's schemas, so every one core holds meets
// 0.2; the vocabularies Keel's profile closes come from the profile, so core is
// seen to hold each one.
const premiseArb = wirePropositionArb("premise").map((p) => told(premiseToMfp(p)));
const effectArb = wirePropositionArb("effect").map((p) => told(effectToMfp(p)));
const mfpCitationArb = citationArb.map(citationToMfp);
const citesArb = fc.array(mfpCitationArb, { minLength: 1, maxLength: 3 });
const anyCitesArb = fc.array(mfpCitationArb, { maxLength: 3 });
const textArb = fc.constantFrom("The premise holds", "keep grants fresh", "x");
const confidenceArb = fc.constantFrom(...MfpIntent.fields.confidence.schema.literals);

const header = <K extends string>(kind: K) => ({
  mfp: fc.constant("0.2" as const),
  kind: fc.constant(kind),
  profile: fc.constant(KEEL_MFP_PROFILE),
});
const HEADER = ["mfp", "kind", "profile"] as const;

const intentArb = fc.record(
  {
    ...header("intent"),
    goal: textArb,
    footprint: fc.array(
      fc.record(
        {
          path: fc.constantFrom("src/authz/**", "src/authz/check.ts"),
          symbol: fc.constantFrom("check", ""),
          op: fc.constantFrom(...FootprintEntry.fields.op.literals),
        },
        { requiredKeys: ["path", "op"] },
      ),
      { maxLength: 2 },
    ),
    premises: fc.array(premiseArb, { maxLength: 3 }),
    declaredEffects: fc.array(effectArb, { maxLength: 3 }),
    cites: anyCitesArb,
    confidence: confidenceArb,
  },
  { requiredKeys: [...HEADER, "goal", "premises"] },
);

const premiseMessageArb = fc.record(
  { ...header("premise"), premise: premiseArb, cites: anyCitesArb, confidence: confidenceArb },
  { requiredKeys: [...HEADER, "premise"] },
);

const decisionArb = fc.record(
  {
    ...header("decision"),
    question: fc.constantFrom("Does the premise hold?", ""),
    chosen: textArb,
    rationale: textArb,
    alternatives: fc.array(fc.record({ option: textArb, reasonRejected: textArb }), {
      maxLength: 2,
    }),
    reversible: fc.boolean(),
    cites: citesArb,
    confidence: confidenceArb,
  },
  { requiredKeys: [...HEADER, "chosen", "rationale", "alternatives", "reversible", "cites"] },
);

const observationArb = fc.record(
  {
    ...header("observation"),
    category: fc.constantFrom(...vocabulary("observation.category")),
    importance: fc.constantFrom(...MfpObservation.fields.importance.literals),
    summary: textArb,
    cites: citesArb,
    confidence: confidenceArb,
  },
  { requiredKeys: [...HEADER, "category", "importance", "summary", "cites"] },
);

const stanceArb = fc.record(
  {
    ...header("stance"),
    decision: fc.constantFrom(DECISION, "D-1"),
    stance: fc.constantFrom(...MfpStance.fields.stance.literals),
    argument: textArb,
    cites: anyCitesArb,
    confidence: confidenceArb,
  },
  { requiredKeys: [...HEADER, "decision", "stance", "argument"] },
);

const verdictArb = fc.record(
  {
    ...header("verdict"),
    outcome: fc.constantFrom(...vocabulary("verdict.outcome")),
    reasons: fc.array(
      fc.record({ summary: textArb, cites: anyCitesArb }, { requiredKeys: ["summary"] }),
      { minLength: 1, maxLength: 3 },
    ),
    residualRisk: fc.constantFrom("none known", ""),
    cites: anyCitesArb,
    confidence: confidenceArb,
  },
  { requiredKeys: [...HEADER, "outcome", "reasons"] },
);

/** Keel's record around a message. */
const recordArb = <M>(message: fc.Arbitrary<M>) =>
  fc.record(
    {
      id: fc.constantFrom(DECISION, GUARD, "run/42"),
      author: fc.record({
        kind: fc.constantFrom(...RecordAuthor.fields.kind.literals),
        id: fc.constantFrom("keel", `user:usr_${ulid(1)}`, `agt_${ulid(1)}`),
      }),
      at: fc.constantFrom(AT, "2026-10-14T01:57:21+01:00"),
      change: fc.constant(CHANGE),
      evidenceClass: fc.constantFrom(...EvidenceClass.literals),
      scope: fc.constantFrom("env:prod", "env:prod;tenant:t1"),
      message,
    },
    { requiredKeys: ["id", "author", "at", "message"] },
  );

const recordsArb = fc.tuple(
  recordArb(intentArb),
  recordArb(premiseMessageArb),
  recordArb(decisionArb),
  recordArb(observationArb),
  recordArb(stanceArb),
  recordArb(verdictArb),
);

/** A record with one edit to its message. */
const edited = <R extends { message: object }>(r: R, edit: Record<string, unknown>) => ({
  ...r,
  message: { ...r.message, ...edit },
});

const decodes = (record: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(KeelRecord)(record));

describe("Keel's records of MFP 0.2 messages", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[mfp.record-spec-agrees] a record of each message kind Keel states is held by core as it is, and MFP 0.2 accepts its message under Keel's profile", () => {
    // Every run's messages are checked in one call: MFP's checker compiles its schemas each time it is called.
    const messages: [string, MfpMessage][] = [];
    fc.assert(
      fc.property(recordsArb, (records) => {
        for (const record of records) {
          const held = Schema.decodeUnknownSync(KeelRecord)(record);
          expect(held).toEqual(record);
          const name = `${held.message.kind} ${String(messages.length).padStart(5, "0")}`;
          messages.push([name, held.message]);
        }
      }),
    );
    const problems = checkMessages(loadWire(), PROFILE, messages);
    expect(
      problems.map((problem) => ({
        problem,
        message: messages.find(([name]) => problem.startsWith(`${name}:`))?.[1],
      })),
    ).toEqual([]);
    // Every kind core holds was stated.
    expect(new Set(messages.map(([, m]) => m.kind))).toEqual(
      new Set(MfpMessage.members.map((m) => m.fields.kind.literal)),
    );
    expect(messages.length).toBeGreaterThan(600);
  });

  it("[mfp.record-refuses] core refuses a record whose message MFP 0.2 refuses under Keel's profile: an outcome or category outside it, no profile or another, a decision citing nothing, a version not 0.2", () => {
    const cites = [{ kind: "record", ref: GUARD }];
    const keel = { kind: "platform", id: "keel" };
    const decision = {
      id: DECISION,
      author: { kind: "human", id: `user:usr_${ulid(1)}` },
      at: AT,
      evidenceClass: "ruling",
      message: {
        mfp: "0.2",
        kind: "decision",
        profile: KEEL_MFP_PROFILE,
        chosen: "premise-holds",
        rationale: "The premise holds",
        alternatives: [],
        reversible: true,
        cites,
      },
    };
    const observation = {
      id: GUARD,
      author: keel,
      at: AT,
      evidenceClass: "proof",
      message: {
        mfp: "0.2",
        kind: "observation",
        profile: KEEL_MFP_PROFILE,
        category: "guard",
        importance: "high",
        summary: `Guard ${GUARD} upholds D-1`,
        cites,
      },
    };
    const verdict = {
      id: "run/42",
      author: keel,
      at: AT,
      change: CHANGE,
      message: {
        mfp: "0.2",
        kind: "verdict",
        profile: KEEL_MFP_PROFILE,
        outcome: "land",
        reasons: [{ summary: "every guard held", cites }],
      },
    };
    const { profile: _profile, ...unprofiled } = decision.message;
    const refused: [string, { message: unknown }][] = [
      ["an outcome outside Keel's vocabulary", edited(verdict, { outcome: "accept" })],
      ["a category outside Keel's vocabulary", edited(observation, { category: "risk" })],
      ["a message naming no profile", { ...decision, message: unprofiled }],
      [
        "a message naming another profile",
        edited(decision, { profile: "https://bimsonz.github.io/mfp/schema/0.2/core" }),
      ],
      ["a decision citing nothing", edited(decision, { cites: [] })],
      ["a verdict with no reasons", edited(verdict, { reasons: [] })],
      ["an MFP 0.1 message", edited(decision, { mfp: "0.1" })],
    ];
    const held: [string, { message: unknown }][] = [
      ["decision", decision],
      ["observation", observation],
      ["verdict", verdict],
    ];

    // Each refused record is one core holds but for its one edit.
    expect(held.filter(([, r]) => !decodes(r)).map(([name]) => name)).toEqual([]);
    expect(refused.filter(([, r]) => decodes(r)).map(([name]) => name)).toEqual([]);

    // MFP refuses each under Keel's profile too, and accepts the records they were made from.
    const problems = checkMessages(
      loadWire(),
      PROFILE,
      [...refused, ...held].map(([name, r]) => [name, r.message]),
    );
    expect(
      refused
        .filter(([name]) => !problems.some((p) => p.startsWith(`${name}:`)))
        .map(([name]) => name),
    ).toEqual([]);
    expect(problems.filter((p) => held.some(([name]) => p.startsWith(`${name}:`)))).toEqual([]);
  });
});
