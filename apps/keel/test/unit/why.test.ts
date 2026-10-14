import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { explainWhy, WHY_LANDINGS, why, whyChain } from "@keeltown/core/application/memory";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import { KEEL_MFP_PROFILE, type WhyLink } from "@keeltown/core/domain/memory";
import {
  CommitSha,
  type EventEnvelope,
  Instant,
  makeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { Decisions, type WhySource, type WhyTarget } from "@keeltown/core/ports";
import { makeDecisionsMemory, projectEvents, ruledConflict } from "@keeltown/testing";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { checkMessages, loadWire, type Profile } from "@bimsonz/mfp/profile";
import { Effect, Layer, Result, Schema } from "effect";
import { ulid } from "ulid";

const SUBJECT = Schema.decodeUnknownSync(SubjectKey)("authz.permission-evaluation");
const FILE = "src/authz/check.ts";
const commitOf = (n: number) => n.toString(16).padStart(40, "e");

type Side = "holder" | "other";

/**
 * A conflict ruled over two changes, as the Projector hears it: both parties
 * declared by their agents and started, the conflict to its guard and
 * escalation, the ruling and its resolution, each side in `early` landed on
 * trunk before the ruling, and each in `landed` afterwards.
 */
function ruled(
  option: "premise-holds" | "effect-stands",
  landed: readonly Side[] = [],
  early: readonly Side[] = [],
) {
  const events = projectEvents();
  const conflict = ruledConflict(events);
  const agents = { holder: makeId("agt", ulid()), other: makeId("agt", ulid()) };
  const commits = { holder: commitOf(1), other: commitOf(2) };
  const against = option === "premise-holds" ? conflict.other : conflict.holder;
  const arrivals: readonly EventEnvelope[] = [
    events.declared(conflict.holder, agents.holder, "Check permissions on every request"),
    events.declared(conflict.other, agents.other, "Cache sessions for an hour"),
    events.started(conflict.holder),
    events.started(conflict.other),
    ...conflict.conflict,
    ...early.flatMap((side) => events.landing(conflict[side], commits[side])),
    conflict.recorded(option),
    conflict.resolved([against]),
    ...landed.flatMap((side) => events.landing(conflict[side], commits[side])),
  ];
  return { events, conflict, agents, commits, against, arrivals };
}

/** The ChangeLanded among these arrivals of one change. */
const landingOf = (arrivals: readonly EventEnvelope[], changeId: string) => {
  const landing = arrivals.find(
    (event) => event.type === "ChangeLanded" && event.entity.id === changeId,
  );
  if (landing === undefined) throw new Error(`${changeId} never landed`);
  return landing;
};

/** What `why` answers in a project after these arrivals, over one in-memory Projector. */
const whyAfter = (arrivals: readonly EventEnvelope[], project: ProjectId, target: WhyTarget) => {
  const memory = makeDecisionsMemory();
  return Effect.gen(function* () {
    for (const event of arrivals) yield* memory.arrive(event);
    return yield* Effect.result(why(project, target));
  }).pipe(Effect.provide(memory.layer));
};

const shape = (chain: readonly WhyLink[]) =>
  chain.map((link) => [link.record.message.kind, link.record.id]);

describe("why", () => {
  it.effect(
    "[why.chain] by subject: each active decision, then the premise, the effect's intent, the guard and the change that landed under it, every link cited",
    () =>
      Effect.gen(function* () {
        const s = ruled("premise-holds", ["holder", "other"]);
        const { conflict } = s;
        // An earlier ruling on the same subject, since superseded, explains nothing now.
        const earlier = ruledConflict(s.events);
        const arrivals = [
          ...earlier.conflict,
          earlier.recorded("premise-holds"),
          earlier.resolved([earlier.other]),
          earlier.superseded(),
          ...s.arrivals,
        ];
        const answered = yield* whyAfter(arrivals, s.events.project, {
          kind: "subject",
          subject: SUBJECT,
        });
        const chain = Result.getOrThrow(answered);
        const premiseId = `${conflict.conflictId}.premise`;
        const intentId = `${conflict.other}.intent.1`;

        // The party the ruling went against landed too, and is not what the decision explains.
        expect(shape(chain)).toEqual([
          ["decision", conflict.decisionId],
          ["premise", premiseId],
          ["intent", intentId],
          ["observation", conflict.guardId],
          ["verdict", `${conflict.holder}.landed.${conflict.decisionId}`],
        ]);
        const [decision, premise, intent, guard, verdict] = chain.map((link) => link.record);
        expect(decision).toMatchObject({
          author: { kind: "platform", id: "keel" },
          evidenceClass: "ruling",
          message: {
            mfp: "0.2",
            profile: KEEL_MFP_PROFILE,
            chosen: "premise-holds",
            rationale: "The premise holds",
            reversible: true,
            cites: [
              { kind: "record", ref: premiseId },
              { kind: "record", ref: intentId },
              { kind: "record", ref: conflict.guardId },
            ],
          },
        });
        expect(premise).toMatchObject({
          change: conflict.holder,
          author: { kind: "agent", id: s.agents.holder },
          message: { premise: conflict.premise },
        });
        expect(intent).toMatchObject({
          change: conflict.other,
          author: { kind: "agent", id: s.agents.other },
          message: { goal: "Cache sessions for an hour", premises: [] },
        });
        expect(intent?.message).not.toHaveProperty("revision");
        expect(guard).toMatchObject({
          evidenceClass: "proof",
          message: {
            category: "guard",
            importance: "high",
            // The premise it asserts, and the probe that proved it.
            cites: [
              { kind: "record", ref: premiseId },
              { kind: "record", ref: expect.stringMatching(/^prb_/) },
            ],
          },
        });
        expect(verdict).toMatchObject({
          change: conflict.holder,
          evidenceClass: "proof",
          message: {
            outcome: "land",
            reasons: [
              {
                summary: expect.stringContaining(`Landed as ${s.commits.holder}`),
                cites: [{ kind: "record", ref: conflict.decisionId }],
              },
            ],
          },
        });
        expect(chain[0]?.summary).toMatch(/^D-\d+ ruled premise-holds: The premise holds$/);
      }),
  );

  it.effect(
    "[why.chain] a ruling for the effect is held by no guard, and the change that made the effect is what landed under it",
    () =>
      Effect.gen(function* () {
        const s = ruled("effect-stands", ["other"]);
        const chain = Result.getOrThrow(
          yield* whyAfter(s.arrivals, s.events.project, { kind: "subject", subject: SUBJECT }),
        );

        expect(shape(chain)).toEqual([
          ["decision", s.conflict.decisionId],
          ["premise", `${s.conflict.conflictId}.premise`],
          ["intent", `${s.conflict.other}.intent.1`],
          ["verdict", `${s.conflict.other}.landed.${s.conflict.decisionId}`],
        ]);
      }),
  );

  it.effect(
    "[why.chain] a favoured party that landed before the ruling did not land under it; one that landed after did, at its ChangeLanded's time whatever arrived on the change since",
    () =>
      Effect.gen(function* () {
        const bySubject: WhyTarget = { kind: "subject", subject: SUBJECT };
        const before = ruled("premise-holds", [], ["holder"]);
        const after = ruled("premise-holds", ["holder"]);
        const { holder } = after.conflict;
        const landing = landingOf(after.arrivals, holder);
        // A conflict noted on the change after it landed arrives last, and is not when it landed.
        const noted = after.events.of({ kind: "change", id: holder }, {
          _tag: "ConflictNoted",
          changeId: holder,
          conflictId: after.conflict.conflictId,
          predicate: "freshness",
          policy: "annotate",
        } as { _tag: string });
        const early = Result.getOrThrow(
          yield* whyAfter(before.arrivals, before.events.project, bySubject),
        );
        const late = Result.getOrThrow(
          yield* whyAfter([...after.arrivals, noted], after.events.project, bySubject),
        );

        expect(landingOf(before.arrivals, before.conflict.holder).at).toBeLessThan(
          before.arrivals.find((event) => event.type === "DecisionRecorded")?.at ?? 0,
        );
        expect(shape(early).map(([kind]) => kind)).toEqual([
          "decision",
          "premise",
          "intent",
          "observation",
        ]);
        expect(noted.at).toBeGreaterThan(landing.at);
        const at = new Date(landing.at).toISOString();
        expect(late.at(-1)?.record).toMatchObject({
          id: `${holder}.landed.${after.conflict.decisionId}`,
          at,
          message: {
            kind: "verdict",
            reasons: [{ summary: expect.stringContaining(`Landed as ${after.commits.holder}`) }],
          },
        });
      }),
  );

  it.effect(
    "[why.chain] a party two decisions favoured landed under each, and each says so in a record of its own",
    () =>
      Effect.gen(function* () {
        const events = projectEvents();
        const first = ruledConflict(events);
        const second = ruledConflict(events, undefined, undefined, { holder: first.holder });
        const arrivals = [
          events.declared(
            first.holder,
            makeId("agt", ulid()),
            "Check permissions on every request",
          ),
          events.declared(first.other, makeId("agt", ulid()), "Cache sessions for an hour"),
          events.declared(second.other, makeId("agt", ulid()), "Cache roles for a day"),
          ...[first.holder, first.other, second.other].map((changeId) => events.started(changeId)),
          ...[first, second].flatMap((ruling) => [
            ...ruling.conflict,
            ruling.recorded("premise-holds"),
            ruling.resolved([ruling.other]),
          ]),
          ...events.landing(first.holder, commitOf(1)),
        ];
        const chain = Result.getOrThrow(
          yield* whyAfter(arrivals, events.project, { kind: "subject", subject: SUBJECT }),
        );
        const ids = chain.map((link) => link.record.id);

        expect(shape(chain).filter(([kind]) => kind === "verdict")).toEqual([
          ["verdict", `${first.holder}.landed.${second.decisionId}`],
          ["verdict", `${first.holder}.landed.${first.decisionId}`],
        ]);
        expect(new Set(ids).size).toBe(ids.length);
      }),
  );

  it.effect(
    "[why.chain] `why` reads the Projector once, through `Decisions.explaining` alone, however many decisions answer",
    () =>
      Effect.gen(function* () {
        const s = ruled("premise-holds", ["holder"]);
        const second = ruledConflict(s.events);
        const memory = makeDecisionsMemory();
        const calls: string[] = [];
        const counted =
          <A extends readonly unknown[], R>(name: string, read: (...args: A) => R) =>
          (...args: A): R => {
            calls.push(name);
            return read(...args);
          };
        // The index alone, each of its reads counted: no read model is there to be asked.
        const counting = Layer.effect(
          Decisions,
          Effect.map(Decisions, (inner) =>
            Decisions.of({
              get: counted("get", inner.get),
              list: counted("list", inner.list),
              ofGuards: counted("ofGuards", inner.ofGuards),
              onSubjects: counted("onSubjects", inner.onSubjects),
              atPath: counted("atPath", inner.atPath),
              explaining: counted("explaining", inner.explaining),
              landedOn: counted("landedOn", inner.landedOn),
            }),
          ),
        ).pipe(Layer.provide(memory.layer));
        for (const event of [
          ...s.arrivals,
          ...second.conflict,
          second.recorded("premise-holds"),
          second.resolved([second.other]),
          s.conflict.minted([FILE]),
        ])
          yield* memory.arrive(event);
        const bySubject = yield* why(s.events.project, { kind: "subject", subject: SUBJECT }).pipe(
          Effect.provide(counting),
        );
        expect(calls).toEqual(["explaining"]);
        const byPath = yield* why(s.events.project, { kind: "path", path: FILE }).pipe(
          Effect.provide(counting),
        );

        expect(calls).toEqual(["explaining", "explaining"]);
        expect(shape(bySubject).filter(([kind]) => kind === "decision")).toEqual([
          ["decision", second.decisionId],
          ["decision", s.conflict.decisionId],
        ]);
        expect(byPath).toEqual(bySubject);
      }),
  );

  it.effect(
    "[why.chain] by path: a file a subject is anchored in answers the subject's chain, its anchors heard before or after the decision, and a line narrows nothing",
    () =>
      Effect.gen(function* () {
        const s = ruled("premise-holds", ["holder"]);
        const minted = s.conflict.minted([FILE, "src/authz/cache.ts"]);
        const bySubject = Result.getOrThrow(
          yield* whyAfter(s.arrivals, s.events.project, { kind: "subject", subject: SUBJECT }),
        );
        const before = yield* whyAfter([minted, ...s.arrivals], s.events.project, {
          kind: "path",
          path: FILE,
        });
        const after = yield* whyAfter([...s.arrivals, minted], s.events.project, {
          kind: "path",
          path: FILE,
          line: 12,
        });

        expect(shape(bySubject)).toHaveLength(5);
        expect(Result.getOrThrow(before)).toEqual(bySubject);
        expect(Result.getOrThrow(after)).toEqual(bySubject);
      }),
  );

  it.effect(
    "[why.chain] nothing to explain: a subject with no decision, one whose only decision was superseded, a file nothing is anchored in, another project",
    () =>
      Effect.gen(function* () {
        const s = ruled("premise-holds");
        const superseded = [...s.arrivals, s.conflict.superseded()];
        const minted = s.conflict.minted([FILE]);
        const asked = [
          yield* whyAfter(s.arrivals, s.events.project, {
            kind: "subject",
            subject: Schema.decodeUnknownSync(SubjectKey)("billing.invoices"),
          }),
          yield* whyAfter(superseded, s.events.project, { kind: "subject", subject: SUBJECT }),
          yield* whyAfter([minted, ...superseded], s.events.project, { kind: "path", path: FILE }),
          yield* whyAfter([minted, ...s.arrivals], s.events.project, {
            kind: "path",
            path: "src/billing.ts",
            line: 3,
          }),
          yield* whyAfter([minted, ...s.arrivals], projectEvents().project, {
            kind: "subject",
            subject: SUBJECT,
          }),
        ];

        expect(asked.map((answer) => Result.isFailure(answer) && answer.failure)).toEqual([
          expect.objectContaining({ _tag: "NothingToExplain", target: "billing.invoices" }),
          expect.objectContaining({ _tag: "NothingToExplain", target: SUBJECT }),
          expect.objectContaining({ _tag: "NothingToExplain", target: FILE }),
          expect.objectContaining({ _tag: "NothingToExplain", target: "src/billing.ts:3" }),
          expect.objectContaining({ _tag: "NothingToExplain", target: SUBJECT }),
        ]);
      }),
  );
});

/** The spec's `KeelRecord`, as the published document has it, compiled with its formats. */
function recordValidator() {
  const document: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../../packages/contracts/openapi.json"), "utf8"),
  );
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  // OpenAPI's numeric formats only name a width; the schema's own bounds carry what MFP asks.
  for (const format of ["int32", "int64", "double"]) ajv.addFormat(format, true);
  ajv.addSchema(Object(document), "openapi.json");
  const validate = ajv.compile({ $ref: "openapi.json#/components/schemas/KeelRecord" });
  return (record: unknown) => ({ valid: validate(record), errors: validate.errors ?? [] });
}

/** Keel's MFP profile, as the spec publishes it. */
const PROFILE: Profile = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../../packages/spec/mfp/keel.profile.json"),
    "utf8",
  ),
);
const WIRE = loadWire();

/** What MFP's own checker, under Keel's profile, refuses in each message: none, for a message that conforms. */
const problemsOf = (messages: readonly (readonly [string, unknown])[]) =>
  checkMessages(
    WIRE,
    PROFILE,
    messages.map(([id, message]) => [id, message]),
  );

/** Whether MFP's checker refuses one message under Keel's profile. */
const refused = (message: unknown) => problemsOf([["m", message]]).length > 0;

/** Every record of a chain that the spec's schema refuses, or whose message MFP refuses, with why. */
const refusedOf = (validate: ReturnType<typeof recordValidator>, chain: readonly WhyLink[]) => [
  ...chain.flatMap((link) => {
    const { valid, errors } = validate(link.record);
    return valid ? [] : [{ id: link.record.id, errors }];
  }),
  ...problemsOf(chain.map((link) => [link.record.id, link.record.message])),
];

describe("why's MFP records", () => {
  const validate = recordValidator();

  it.effect(
    "[why.mfp] every record a chain holds is the spec's KeelRecord, and its message conforms to MFP 0.2 under Keel's profile by MFP's own checker: with a guard and landings, without either, and with every optional field the mapper writes",
    () =>
      Effect.gen(function* () {
        const guarded = ruled("premise-holds", ["holder", "other"]);
        const unguarded = ruled("effect-stands");
        const memory = makeDecisionsMemory();
        const chains = yield* Effect.gen(function* () {
          for (const event of [...guarded.arrivals, ...unguarded.arrivals])
            yield* memory.arrive(event);
          const decisions = yield* Decisions;
          const plain: WhySource[] = [];
          for (const s of [guarded, unguarded])
            plain.push(
              ...(yield* decisions.explaining(s.events.project, {
                kind: "subject",
                subject: SUBJECT,
              })),
            );
          const [base] = plain;
          const record = base?.conflict;
          if (base === undefined || record === undefined) throw new Error("no conflict folded");
          const premise = record.conflict.premise;
          if (premise === undefined) throw new Error("no premise folded");
          const anchor = { path: FILE, symbol: "check", commit: CommitSha.make(commitOf(9)) };
          // Every branch of the mapper at once: a ruling a person gave with a question asked,
          // alternatives with and without a reason, a scope, and a premise carrying all it may.
          const rich = {
            ...base,
            decision: {
              ...base.decision,
              decision: {
                ...base.decision.decision,
                summary: "",
                scope: "env:prod",
                alternatives: [
                  { option: "effect-stands", reasonRejected: "" },
                  { option: "split-the-cache", reasonRejected: "Costs a second store" },
                  { option: "", reasonRejected: "Unnamed" },
                ],
              },
            },
            conflict: {
              ...record,
              conflict: {
                ...record.conflict,
                premise: {
                  ...premise,
                  proposition: {
                    ...premise.proposition,
                    predicate: "bound" as const,
                    relation: "at-most" as const,
                    value: 30,
                    unit: "s",
                    scope: "tenant:t1",
                    gloss: "Permissions are read fresh",
                    strength: "should" as const,
                    anchors: [anchor],
                    cites: [
                      { _tag: "anchor" as const, anchor },
                      { _tag: "record" as const, id: "rec-1" },
                      {
                        _tag: "message" as const,
                        session: makeId("ses", ulid()),
                        seq: 4,
                      },
                    ],
                  },
                },
              },
              escalation: {
                id: base.decision.decision.escalationId,
                state: "ruled" as const,
                question: "Does the premise hold?",
                options: [],
                about: { kind: "conflict" as const, id: record.conflict.id },
                category: "unprovable-conflict" as const,
                evidence: [],
                precedents: [],
                default: "premise-holds",
                raisedAt: Instant(0),
                ruling: { option: "premise-holds", by: makeId("usr", ulid()) },
              },
            },
          };
          return [...plain.map((sources) => whyChain(sources)), whyChain(rich)];
        }).pipe(Effect.provide(memory.layer));
        const [withBoth, withNeither, everything] = chains;

        expect(shape(withBoth ?? []).map(([kind]) => kind)).toEqual([
          "decision",
          "premise",
          "intent",
          "observation",
          "verdict",
        ]);
        expect(shape(withNeither ?? []).map(([kind]) => kind)).toEqual([
          "decision",
          "premise",
          "intent",
        ]);
        expect(everything?.[0]?.record).toMatchObject({
          author: { kind: "human" },
          scope: "env:prod",
          message: { question: "Does the premise hold?", rationale: "premise-holds" },
        });
        expect(everything?.[1]?.record.message).toMatchObject({
          premise: { predicate: "bound", value: 30, unit: "s", strength: "should" },
        });
        expect(chains.flatMap((chain) => refusedOf(validate, chain))).toEqual([]);
        // The checks are the spec's and MFP's, and refuse what each refuses: neither is `{}`.
        const [decision, , , guard, landing] = (withBoth ?? []).map((link) => link.record);
        expect(validate({ ...decision, extra: true }).valid).toBe(false);
        expect(validate({ ...decision, at: "yesterday" }).valid).toBe(false);
        expect(refused(decision?.message)).toBe(false);
        expect(refused({ ...decision?.message, cites: [] })).toBe(true);
        // What MFP 0.2 dropped is Keel's record's, never the message's.
        expect(refused({ ...decision?.message, evidenceClass: "ruling" })).toBe(true);
        expect(refused({ ...guard?.message, cites: [] })).toBe(true);
        expect(refused({ ...landing?.message, outcome: "accept" })).toBe(true);
      }),
  );

  it.effect(
    "[why.untellable] a premise with no 0.2 form is not stated, never repaired: the decision still cites the intent and the guard, and the guard its probe",
    () =>
      Effect.gen(function* () {
        const guarded = ruled("premise-holds", ["holder", "other"]);
        const memory = makeDecisionsMemory();
        const [source] = yield* Effect.gen(function* () {
          for (const event of guarded.arrivals) yield* memory.arrive(event);
          return yield* (yield* Decisions).explaining(guarded.events.project, {
            kind: "subject",
            subject: SUBJECT,
          });
        }).pipe(Effect.provide(memory.layer));
        const record = source?.conflict;
        const premise = record?.conflict.premise;
        if (source === undefined || record === undefined || premise === undefined)
          throw new Error("no conflict folded");
        // Stored before 0.2: a writer with a space in it, which 0.2's `Writer` cannot hold.
        const chain = whyChain({
          ...source,
          conflict: {
            ...record,
            conflict: {
              ...record.conflict,
              premise: {
                ...premise,
                proposition: {
                  ...premise.proposition,
                  predicate: "authority" as const,
                  relation: "at-most" as const,
                  value: "release team,alice",
                },
              },
            },
          },
        });
        expect(shape(chain).map(([kind]) => kind)).toEqual([
          "decision",
          "intent",
          "observation",
          "verdict",
        ]);
        const [decision, intent, guard] = chain.map((link) => link.record);
        expect(decision?.message).toMatchObject({
          cites: [
            { kind: "record", ref: intent?.id },
            { kind: "record", ref: guard?.id },
          ],
        });
        expect(guard?.message).toMatchObject({
          cites: [{ kind: "record", ref: expect.stringMatching(/^prb_/) }],
        });
        expect(refusedOf(validate, chain)).toEqual([]);
      }),
  );
});

/** What `why` answers with a path's landings, after these arrivals, over one in-memory Projector. */
const explainAfter = (
  arrivals: readonly EventEnvelope[],
  project: ProjectId,
  target: WhyTarget,
) => {
  const memory = makeDecisionsMemory();
  return Effect.gen(function* () {
    for (const event of arrivals) yield* memory.arrive(event);
    return yield* Effect.result(explainWhy(project, target));
  }).pipe(Effect.provide(memory.layer));
};

/** A change declared, started and landed as `commit`, its derivation touching `paths`. */
const landedChange = (
  events: ReturnType<typeof projectEvents>,
  goal: string,
  commit: string,
  paths: readonly string[],
) => {
  const changeId = makeId("chg", ulid());
  return {
    changeId,
    arrivals: [
      events.declared(changeId, makeId("agt", ulid()), goal),
      events.started(changeId),
      ...events.landing(changeId, commit, paths),
    ],
  };
};

describe("why, where no decision explains a path", () => {
  it.effect(
    `[why.landings] a path no decision explains is explained by the ${WHY_LANDINGS} changes that landed on it most recently, newest first, each its intent as its agent declared it, saying no decision is recorded there; a line does not narrow it, and a path nothing landed on is nothing to explain`,
    () => {
      const events = projectEvents();
      const takes = [1, 2, 3, 4].map((n) =>
        landedChange(events, `Price it, take ${n}`, commitOf(10 + n), ["src/pay.ts"]),
      );
      const other = landedChange(events, "Elsewhere", commitOf(20), ["src/other.ts"]);
      const arrivals = [...takes.flatMap((t) => t.arrivals), ...other.arrivals];
      return Effect.gen(function* () {
        const answer = Result.getOrThrow(
          yield* explainAfter(arrivals, events.project, { kind: "path", path: "src/pay.ts" }),
        );
        const newest = takes.toReversed().slice(0, WHY_LANDINGS);
        expect(answer.basis).toBe("landings");
        expect(answer.chain.map((link) => link.summary)).toEqual(
          newest.map(
            ({ changeId }, i) =>
              `No decision is recorded on src/pay.ts: ${changeId} landed it as ${commitOf(14 - i).slice(0, 12)}, intending "Price it, take ${4 - i}"`,
          ),
        );
        expect(
          answer.chain.map((link) => [
            link.record.id,
            link.record.change,
            link.record.message.kind,
          ]),
        ).toEqual(newest.map(({ changeId }) => [`${changeId}.intent.1`, changeId, "intent"]));
        const withLine = Result.getOrThrow(
          yield* explainAfter(arrivals, events.project, {
            kind: "path",
            path: "src/pay.ts",
            line: 3,
          }),
        );
        expect(withLine).toEqual(answer);
        const nothing = yield* explainAfter(arrivals, events.project, {
          kind: "path",
          path: "src/none.ts",
        });
        expect(Result.isFailure(nothing) && nothing.failure._tag).toBe("NothingToExplain");
      });
    },
  );

  it.effect(
    "[why.landings.decided-first] a path a decision explains answers the decision alone, whatever landed there, and a subject no decision explains is nothing to explain, whatever landed",
    () => {
      const s = ruled("premise-holds");
      const onFile = landedChange(s.events, "Edit the check", commitOf(30), [FILE]);
      const arrivals = [...s.arrivals, s.conflict.minted([FILE]), ...onFile.arrivals];
      return Effect.gen(function* () {
        const byPath = Result.getOrThrow(
          yield* explainAfter(arrivals, s.events.project, { kind: "path", path: FILE }),
        );
        expect(byPath.basis).toBe("decisions");
        expect(byPath.chain.map((link) => link.record.message.kind)).toContain("decision");
        expect(byPath.chain.some((link) => link.summary.startsWith("No decision"))).toBe(false);
        const bySubject = yield* explainAfter(arrivals, s.events.project, {
          kind: "subject",
          subject: Schema.decodeUnknownSync(SubjectKey)("billing.invoices"),
        });
        expect(Result.isFailure(bySubject) && bySubject.failure._tag).toBe("NothingToExplain");
      });
    },
  );
});
