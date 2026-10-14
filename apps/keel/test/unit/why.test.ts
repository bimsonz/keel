import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { why, whyChain, whySources, type WhyTarget } from "@keeltown/core/application/memory";
import { SubjectKey } from "@keeltown/core/domain/coordination";
import type { WhyLink } from "@keeltown/core/domain/memory";
import {
  CommitSha,
  type EventEnvelope,
  Instant,
  makeId,
  type ProjectId,
} from "@keeltown/core/kernel";
import { Decisions } from "@keeltown/core/ports";
import { makeProjectorMemory, projectEvents, ruledConflict } from "@keeltown/testing";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Effect, Result, Schema } from "effect";
import { ulid } from "ulid";

const SUBJECT = Schema.decodeUnknownSync(SubjectKey)("authz.permission-evaluation");
const FILE = "src/authz/check.ts";
const commitOf = (n: number) => n.toString(16).padStart(40, "e");

type Side = "holder" | "other";

/**
 * A conflict ruled over two changes, as the Projector hears it: both parties
 * declared by their agents and started, the conflict to its guard and
 * escalation, the ruling and its resolution, and each side in `landed`
 * landed on trunk afterwards.
 */
function ruled(option: "premise-holds" | "effect-stands", landed: readonly Side[] = []) {
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
    conflict.recorded(option),
    conflict.resolved([against]),
    ...landed.flatMap((side) => events.landing(conflict[side], commits[side])),
  ];
  return { events, conflict, agents, commits, against, arrivals };
}

/** What `why` answers in a project after these arrivals, over one in-memory Projector. */
const whyAfter = (arrivals: readonly EventEnvelope[], project: ProjectId, target: WhyTarget) => {
  const memory = makeProjectorMemory();
  return Effect.gen(function* () {
    for (const event of arrivals) yield* memory.arrive(event);
    return yield* Effect.result(why(project, target));
  }).pipe(Effect.provide(memory.layer));
};

const shape = (chain: readonly WhyLink[]) =>
  chain.map((link) => [link.record.kind, link.record.id]);

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
          ["verdict", `${conflict.holder}.landed`],
        ]);
        const [decision, premise, intent, guard, verdict] = chain.map((link) => link.record);
        expect(decision).toMatchObject({
          author: { kind: "platform", id: "keel" },
          evidenceClass: "ruling",
          cites: [
            { kind: "record", id: premiseId },
            { kind: "record", id: intentId },
            { kind: "record", id: conflict.guardId },
          ],
          payload: { chosen: "premise-holds", rationale: "The premise holds", reversible: true },
        });
        expect(premise).toMatchObject({
          change: conflict.holder,
          author: { kind: "agent", id: s.agents.holder },
          payload: { proposition: { ...conflict.premise, strength: "must" } },
        });
        expect(intent).toMatchObject({
          change: conflict.other,
          author: { kind: "agent", id: s.agents.other },
          payload: { revision: 1, goal: "Cache sessions for an hour", premises: [] },
        });
        expect(guard).toMatchObject({
          evidenceClass: "proof",
          cites: [{ kind: "record", id: premiseId }],
          payload: { category: "guard", importance: "high", evidence: [{ class: "proof" }] },
        });
        expect(verdict).toMatchObject({
          change: conflict.holder,
          cites: [{ kind: "record", id: conflict.decisionId }],
          payload: { outcome: "land", reasons: [{ class: "proof", ref: s.commits.holder }] },
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
          ["verdict", `${s.conflict.other}.landed`],
        ]);
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

/** The spec's `MFP.MfpRecord`, as the published document has it, compiled with its formats. */
function recordValidator() {
  const document: unknown = JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../../packages/contracts/openapi.json"), "utf8"),
  );
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  // OpenAPI's numeric formats only name a width; the schema's own bounds carry what MFP asks.
  for (const format of ["int32", "int64", "double"]) ajv.addFormat(format, true);
  ajv.addSchema(Object(document), "openapi.json");
  const validate = ajv.compile({ $ref: "openapi.json#/components/schemas/MFP.MfpRecord" });
  return (record: unknown) => ({ valid: validate(record), errors: validate.errors ?? [] });
}

/** Every record of a chain that the spec's schema refuses, with why. */
const refusedOf = (validate: ReturnType<typeof recordValidator>, chain: readonly WhyLink[]) =>
  chain.flatMap((link) => {
    const { valid, errors } = validate(link.record);
    return valid ? [] : [{ id: link.record.id, errors }];
  });

describe("why's MFP records", () => {
  const validate = recordValidator();

  it.effect(
    "[why.mfp] every record a chain holds is an MFP 0.1 record by the spec's own schema: with a guard and landings, without either, and with every optional field the mapper writes",
    () =>
      Effect.gen(function* () {
        const guarded = ruled("premise-holds", ["holder", "other"]);
        const unguarded = ruled("effect-stands");
        const memory = makeProjectorMemory();
        const chains = yield* Effect.gen(function* () {
          for (const event of [...guarded.arrivals, ...unguarded.arrivals])
            yield* memory.arrive(event);
          const decisions = yield* Decisions;
          const plain = [];
          for (const s of [guarded, unguarded])
            plain.push(
              yield* whySources(s.events.project, yield* decisions.get(s.conflict.decisionId)),
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
          payload: { question: "Does the premise hold?", rationale: "premise-holds" },
        });
        expect(chains.flatMap((chain) => refusedOf(validate, chain))).toEqual([]);
        // The schema is the spec's and refuses what MFP refuses: it is no `{}`.
        const decision = withBoth?.[0]?.record;
        expect(validate({ ...decision, cites: [] }).valid).toBe(false);
        expect(validate({ ...decision, author: { kind: "agent", id: "" } }).valid).toBe(false);
        expect(validate({ ...decision, extra: true }).valid).toBe(false);
        expect(validate({ ...decision, at: "yesterday" }).valid).toBe(false);
      }),
  );
});
