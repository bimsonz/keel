import { describe, expect, it } from "@effect/vitest";
import {
  askAbout,
  decisionIdOf,
  EFFECT_STANDS,
  escalationIdOf,
  PREMISE_HOLDS,
} from "@keeltown/core/application/coordination";
import { actionsOf, detailOf } from "@keeltown/core/application/identity";
import {
  escalationView,
  foldEscalationViews,
  listedTo,
  MAINTAINERS_AFTER_MS,
} from "@keeltown/core/application/memory";
import { decideEscalation } from "@keeltown/core/domain/verification";
import {
  type ConflictId,
  type EntityRef,
  EventEnvelope,
  Instant,
  makeId,
  type OrgId,
  type UserId,
} from "@keeltown/core/kernel";
import {
  ConflictMoves,
  type EscalationRecord,
  Escalations,
  HumanGate,
  ProbeLedger,
  type RaiseRequest,
  type SubjectRef,
} from "@keeltown/core/ports";
import {
  BUNDLE,
  conflictOn,
  DISCRIMINATING,
  makeEntityStoreMemory,
  makeEscalationsMemory,
  makeProbeLedgerMemory,
} from "@keeltown/testing";
import { Effect, Result, Schema } from "effect";
import * as fc from "fast-check";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 100, ...(seed === undefined ? {} : { seed: Number(seed) }) });

/** A property of many commits takes a second alone and several in the whole suite under load. */
const PROPERTY_TIMEOUT = 60_000;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let made = 0;
/** Distinct ids without randomness, so a seeded run replays exactly. */
const nextId = <P extends "cfl" | "prj" | "org" | "usr" | "agt" | "esc" | "dec" | "evt" | "chg">(
  prefix: P,
) => {
  made += 1;
  let n = made;
  let body = "";
  for (let i = 0; i < 26; i += 1) {
    body = (CROCKFORD[n % 32] ?? "0") + body;
    n = Math.floor(n / 32);
  }
  return makeId(prefix, body);
};

const types = (log: readonly EventEnvelope[]) => log.map((event) => event.type);

describe("raising an escalation", () => {
  it(
    "[t35.raise-once] however a conflict's escalation is raised (retried, by another party, in any order among others), it is one escalation, as first raised",
    () => {
      const attempt = fc.record({
        conflict: fc.integer({ min: 0, max: 3 }),
        sponsor: fc.option(fc.integer({ min: 0, max: 2 }), { nil: undefined }),
        question: fc.integer({ min: 0, max: 2 }),
      });
      fc.assert(
        fc.property(fc.array(attempt, { minLength: 1, maxLength: 14 }), (attempts) => {
          const memory = makeEscalationsMemory();
          const namespace = nextId("org");
          const project = nextId("prj");
          const conflicts = [0, 1, 2, 3].map(() => nextId("cfl"));
          const sponsors = [0, 1, 2].map(() => nextId("usr"));
          const request = (each: (typeof attempts)[number]): RaiseRequest => {
            const conflictId = conflicts[each.conflict] ?? nextId("cfl");
            const sponsor = each.sponsor === undefined ? undefined : sponsors[each.sponsor];
            return {
              namespace,
              escalationId: escalationIdOf(conflictId),
              project,
              ...(sponsor === undefined ? {} : { sponsor }),
              raisedBy: `subj:${project}:authz.session`,
              ask: {
                question: `Question ${each.question}?`,
                options: [
                  { id: PREMISE_HOLDS, label: "The premise holds", consequence: "one gives way" },
                  { id: EFFECT_STANDS, label: "The effect stands", consequence: "the other does" },
                ],
                about: { kind: "conflict", id: conflictId },
                category: "ambiguous-requirement",
                evidence: [],
                precedents: [],
                default: PREMISE_HOLDS,
              },
            };
          };
          const first = new Map<number, RaiseRequest>();
          const answered = attempts.map((each) => {
            const asked = request(each);
            if (!first.has(each.conflict)) first.set(each.conflict, asked);
            const record = Effect.runSync(
              HumanGate.use((gate) => gate.raise(asked)).pipe(Effect.provide(memory.layer)),
            );
            return { conflict: each.conflict, record };
          });

          // Every answer is the escalation as its first raise left it.
          expect(
            answered.map(({ record }) => [
              record.escalation.id,
              record.escalation.question,
              record.sponsor,
            ]),
          ).toEqual(
            answered.map(({ conflict }) => {
              const one = first.get(conflict);
              return [one?.escalationId, one?.ask.question, one?.sponsor];
            }),
          );
          // One EscalationRaised a conflict, and the list holds each exactly once.
          expect(
            [...first.values()].map((one) =>
              types(memory.log(namespace, { kind: "escalation", id: one.escalationId })),
            ),
          ).toEqual([...first.values()].map(() => ["EscalationRaised"]));
          const listed = Effect.runSync(
            Escalations.use((escalations) =>
              escalations.list({ reader: { _tag: "Project", project }, now: Instant(0) }),
            ).pipe(Effect.provide(memory.layer)),
          );
          expect(listed.items.map((item) => item.escalation.id).toSorted()).toEqual(
            [...first.values()].map((one) => one.escalationId).toSorted(),
          );
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );
});

/** A conflict on a memory ledger, taken to where the question is asked: untouched, proven, or its drafting failed. */
function viewAt(sides: boolean, probe: "none" | "admitted" | "draft-failed") {
  const memory = makeProbeLedgerMemory();
  const { at, conflictId, holder, other, suspect } = conflictOn();
  const { premise: _premise, effect: _effect, ...bare } = suspect;
  const program = Effect.gen(function* () {
    const ledger = yield* ProbeLedger;
    yield* memory.suspect(at, conflictId, sides ? suspect : bare);
    if (probe === "draft-failed")
      yield* ledger.probeDraftFailed(at, { conflictId, attempts: 3, reason: "abstained" });
    if (probe === "admitted") {
      const drafted = yield* ledger.probeDrafted(at, {
        conflictId,
        attempts: 1,
        bundleHash: BUNDLE,
      });
      const probeId = drafted.probe?.id;
      if (probeId === undefined) throw new Error("a draft answers its probe");
      for (const run of [1, 2, 3])
        for (const [world, outcome] of DISCRIMINATING)
          yield* ledger.probeCellRan(at, {
            conflictId,
            probeId,
            world,
            run,
            outcome,
            resultRef: `r2://probe/${run}/${world}`,
          });
    }
    return yield* ledger.conflict(at, conflictId);
  });
  return {
    memory,
    at,
    conflictId,
    holder,
    other,
    view: Effect.runSync(Effect.orDie(program).pipe(Effect.provide(memory.layer))),
  };
}

describe("the question a conflict is put to a person with", () => {
  it(
    "[t35.question] is always one the domain will raise: two options under fixed ids, the premise kept by default, about the conflict, with the evidence Keel holds and the agent's own note",
    () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.constantFrom("none", "admitted", "draft-failed"),
          fc.constantFrom("human-class", "unprovable"),
          fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
          (sides, probe, reason, note) => {
            // The domain drafts no probe for a conflict that names no premise and effect.
            fc.pre(sides || probe !== "admitted");
            const { view, conflictId, holder, other } = viewAt(sides, probe);
            const ask = askAbout(view, reason, note);
            const raised = decideEscalation(
              undefined,
              { _tag: "Raise", ...ask },
              { now: Instant(0), escalationId: escalationIdOf(conflictId) },
            );
            const classes = ask.evidence.map((evidence) => evidence.class);
            const summaries = ask.evidence.map((evidence) => evidence.summary);

            expect(Result.isSuccess(raised)).toBe(true);
            expect(ask.options.map((option) => option.id)).toEqual([PREMISE_HOLDS, EFFECT_STANDS]);
            expect(ask.default).toBe(PREMISE_HOLDS);
            expect(ask.about).toEqual({ kind: "conflict", id: conflictId });
            expect(ask.category).toBe(
              reason === "unprovable" ? "unprovable-conflict" : "ambiguous-requirement",
            );
            expect(classes.includes("proof")).toBe(probe === "admitted");
            expect(classes.includes("ruling")).toBe(probe === "draft-failed");
            expect(summaries.includes(note ?? "")).toBe(note !== undefined);
            // Each option says what it means for both changes, and the question names them.
            expect(
              ask.options.map(
                (option) =>
                  option.consequence.includes(holder) && option.consequence.includes(other),
              ),
            ).toEqual([true, true]);
            expect(ask.question.includes(holder) && ask.question.includes(other)).toBe(true);
            expect(ask.question.includes("per-request")).toBe(sides);
          },
        ),
        { numRuns: 60 },
      );
    },
    PROPERTY_TIMEOUT,
  );
});

const recordAt = (namespace: OrgId, raisedAt: number, sponsor?: UserId): EscalationRecord => {
  const conflictId = nextId("cfl");
  return {
    escalation: {
      id: escalationIdOf(conflictId),
      state: "open",
      question: "Which holds?",
      options: [],
      about: { kind: "conflict", id: conflictId },
      category: "ambiguous-requirement",
      evidence: [],
      precedents: [],
      default: PREMISE_HOLDS,
      raisedAt: Instant(raisedAt),
    },
    namespace,
    project: nextId("prj"),
    ...(sponsor === undefined ? {} : { sponsor }),
  };
};

describe("whose list an escalation is in", () => {
  it("[t35.sponsor-then-maintainers] over the clock: the user asked first from the start, the namespace's maintainers from thirty minutes on or at once when nobody is asked first, and nobody else ever", () => {
    const [here, elsewhere] = [nextId("org"), nextId("org")];
    const [sponsor, someone] = [nextId("usr"), nextId("usr")];
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.constantFrom("sponsor", "someone"),
        fc.subarray([here, elsewhere]),
        fc.integer({ min: 0, max: 4 * MAINTAINERS_AFTER_MS }),
        fc.integer({ min: 0, max: 1_800_000_000_000 }),
        (asked, who, maintains, elapsed, raisedAt) => {
          const record = recordAt(here, raisedAt, asked ? sponsor : undefined);
          const userId = who === "sponsor" ? sponsor : someone;
          const listed = listedTo(
            record,
            { _tag: "User", userId, maintains },
            Instant(raisedAt + elapsed),
          );
          const askedFirst = asked && who === "sponsor";
          const maintainersTurn = !asked || elapsed >= MAINTAINERS_AFTER_MS;
          expect(listed).toBe(askedFirst || (maintains.includes(here) && maintainersTurn));
        },
      ),
    );
  });

  it("[t35.sponsor-then-maintainers] the maintainers' turn comes at exactly thirty minutes, not a millisecond before", () => {
    const here = nextId("org");
    const record = recordAt(here, 1_000, nextId("usr"));
    const maintainer = { _tag: "User", userId: nextId("usr"), maintains: [here] } as const;
    expect([
      listedTo(record, maintainer, Instant(1_000 + MAINTAINERS_AFTER_MS - 1)),
      listedTo(record, maintainer, Instant(1_000 + MAINTAINERS_AFTER_MS)),
    ]).toEqual([false, true]);
    expect(MAINTAINERS_AFTER_MS).toBe(30 * 60 * 1000);
  });

  it("[t35.other-namespace-unlisted] an escalation is never listed to a maintainer of other namespaces only, nor to an agent of another project, however long it waits", () => {
    const [here, elsewhere] = [nextId("org"), nextId("org")];
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 0, max: 1000 * MAINTAINERS_AFTER_MS }),
        (asked, elapsed) => {
          const record = recordAt(here, 0, asked ? nextId("usr") : undefined);
          const now = Instant(elapsed);
          expect([
            listedTo(record, { _tag: "User", userId: nextId("usr"), maintains: [elsewhere] }, now),
            listedTo(record, { _tag: "Project", project: nextId("prj") }, now),
            listedTo(record, { _tag: "Project", project: record.project }, now),
          ]).toEqual([false, false, true]);
        },
      ),
    );
  });
});

const decisionRef = (conflictId: ConflictId): EntityRef => ({
  kind: "decision",
  id: decisionIdOf(escalationIdOf(conflictId)),
});

/** A proven conflict in a placed project, escalated by its premise holder and ruled on: the decision the namespace committed. */
function ruled() {
  const { memory, at, conflictId, holder, other } = viewAt(true, "admitted");
  const namespace = nextId("org");
  const by = nextId("usr");
  memory.orgs.places.set(at.projectId, { projectId: at.projectId, org: namespace, name: "p" });
  const program = Effect.gen(function* () {
    yield* (yield* ConflictMoves).resolve(at, {
      conflictId,
      changeId: holder,
      agentId: nextId("agt"),
      sponsor: by,
      move: "escalate",
      idempotencyKey: "resolve-1",
    });
    yield* (yield* Escalations).rule({
      escalationId: escalationIdOf(conflictId),
      option: EFFECT_STANDS,
      by,
      idempotencyKey: "rule-1",
    });
  });
  Effect.runSync(Effect.orDie(program).pipe(Effect.provide(memory.world)));
  const [decision] = memory.escalations.log(namespace, decisionRef(conflictId));
  if (decision === undefined) throw new Error("a ruling records its decision");
  return { memory, at, conflictId, holder, other, decision };
}

const conflictLog = (memory: ReturnType<typeof ruled>["memory"], at: SubjectRef, id: ConflictId) =>
  Effect.runSync(memory.log(at, { kind: "conflict", id }));

describe("a subject hearing the decision of an escalation it raised", () => {
  it("[t35.hear-decision] resolves the conflict the decision is about, with that decision and the move escalate, telling both parties, once", () => {
    const { memory, at, conflictId, holder, other, decision } = ruled();
    const before = types(conflictLog(memory, at, conflictId));
    const reaction = Effect.runSync(memory.hear(at, decision));
    const again = Effect.runSync(memory.hear(at, decision));
    const log = conflictLog(memory, at, conflictId);
    const view = Effect.runSync(
      ProbeLedger.use((ledger) => ledger.conflict(at, conflictId)).pipe(
        Effect.orDie,
        Effect.provide(memory.layer),
      ),
    );

    expect(before.at(-1)).toBe("ConflictEscalated");
    expect(reaction.problems).toBeUndefined();
    expect(view.conflict).toMatchObject({
      state: "resolved",
      move: "escalate",
      decisionId: decisionIdOf(escalationIdOf(conflictId)),
    });
    expect(log.filter((event) => event.type === "ConflictResolved")).toHaveLength(1);
    expect(log.at(-1)).toMatchObject({
      type: "ConflictResolved",
      project: at.projectId,
      causation: decision.eventId,
      payload: { conflictId, move: "escalate", decisionId: view.conflict.decisionId },
      affected: [
        { kind: "change", id: holder },
        { kind: "change", id: other },
      ],
    });
    // A decision heard again resolves nothing more, and says so.
    expect(again.drafts).toEqual([]);
    expect(again.problems).toHaveLength(1);
  });

  it("[t35.hear-decision] resolves nothing on a decision that is not its conflict's: another escalation's, or one naming no conflict it hosts", () => {
    const { memory, at, conflictId, decision } = ruled();
    const forged = Schema.decodeUnknownSync(EventEnvelope)({
      ...Schema.encodeSync(EventEnvelope)(decision),
      payload: {
        ...Object(decision.payload),
        escalationId: nextId("esc"),
        decisionId: nextId("dec"),
      },
    });
    const stray = Schema.decodeUnknownSync(EventEnvelope)({
      ...Schema.encodeSync(EventEnvelope)(decision),
      affected: [{ kind: "conflict", id: nextId("cfl") }],
    });
    const reactions = [forged, stray].map((event) => Effect.runSync(memory.hear(at, event)));

    expect(reactions.map((reaction) => reaction.drafts)).toEqual([[], []]);
    expect(reactions.map((reaction) => reaction.problems?.length)).toEqual([1, 1]);
    expect(types(conflictLog(memory, at, conflictId)).at(-1)).toBe("ConflictEscalated");
  });
});

const arrived = (
  type: string,
  entity: EntityRef,
  payload: object,
  extra: { readonly project?: string; readonly affected?: readonly EntityRef[] } = {},
) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: nextId("evt"),
    type,
    entity,
    seq: 1,
    at: 5_000,
    dedupeKey: `${type}#${made}`,
    affected: extra.affected ?? [],
    notified: [],
    ...(extra.project === undefined ? {} : { project: extra.project }),
    payload: { _tag: type, ...payload },
  });

describe("what an agent is told of its conflict's escalation", () => {
  it("[t35.told] a conflict put to a person, and its ruling, each say which escalation or decision, with where to read it; a parked or resumed change says what it waits for or was decided by", () => {
    const conflictId = nextId("cfl");
    const escalationId = escalationIdOf(conflictId);
    const decisionId = decisionIdOf(escalationId);
    const conflict: EntityRef = { kind: "conflict", id: conflictId };
    const change: EntityRef = { kind: "change", id: nextId("chg") };
    const escalated = arrived("ConflictEscalated", conflict, {
      conflictId,
      escalationId,
      reason: "unprovable",
    });
    const resolved = arrived("ConflictResolved", conflict, {
      conflictId,
      move: "escalate",
      decisionId,
    });
    const parked = arrived("ChangeParked", change, {
      changeId: change.id,
      reason: "awaiting-ruling",
      escalationId,
    });
    const resumed = arrived("ChangeResumed", change, { changeId: change.id, decisionId });

    expect([escalated, resolved, parked, resumed].map(detailOf)).toEqual([
      `${conflictId} was put to a person as ${escalationId}: Keel could not prove it either way`,
      `decided by ${decisionId}`,
      `waiting for a ruling on ${escalationId}`,
      `decided by ${decisionId}`,
    ]);
    expect([escalated, resolved].map((event) => actionsOf(event))).toEqual([
      [expect.objectContaining({ operationId: "Conflicts_getConflict", args: { conflictId } })],
      [expect.objectContaining({ operationId: "Conflicts_getConflict", args: { conflictId } })],
    ]);
    expect([parked, resumed].map((event) => actionsOf(event))).toEqual([undefined, undefined]);
  });
});

describe("the Projector's fold of escalations", () => {
  it("[t35.escalation-fold] an escalation raised with no namespace or no project is not folded and is reported, and a decision for one never heard raised is reported", () => {
    const store = makeEntityStoreMemory().service;
    const conflictId = nextId("cfl");
    const escalationId = escalationIdOf(conflictId);
    const entity: EntityRef = { kind: "escalation", id: escalationId };
    const raised = {
      escalationId,
      question: "Which holds?",
      options: [
        { id: PREMISE_HOLDS, label: "a", consequence: "b" },
        { id: EFFECT_STANDS, label: "c", consequence: "d" },
      ],
      about: { kind: "conflict", id: conflictId },
      category: "ambiguous-requirement",
      evidence: [],
      precedents: [],
      default: PREMISE_HOLDS,
    };
    const namespace = nextId("org");
    const project = nextId("prj");
    const unplaced = foldEscalationViews(
      store,
      arrived("EscalationRaised", entity, raised, { project }),
    );
    const noProject = foldEscalationViews(
      store,
      arrived("EscalationRaised", entity, raised, {
        affected: [{ kind: "org", id: namespace }],
      }),
    );
    const early = foldEscalationViews(
      store,
      arrived(
        "DecisionRecorded",
        { kind: "decision", id: decisionIdOf(escalationId) },
        {
          decisionId: decisionIdOf(escalationId),
          escalationId,
          option: PREMISE_HOLDS,
          summary: "a",
          evidence: [],
          alternatives: [],
        },
        { project },
      ),
    );
    const absent = escalationView(store, escalationId);
    const placed = foldEscalationViews(
      store,
      arrived("EscalationRaised", entity, raised, {
        project,
        affected: [{ kind: "org", id: namespace }],
      }),
    );

    expect([unplaced, noProject, early].map((problem) => typeof problem)).toEqual([
      "string",
      "string",
      "string",
    ]);
    expect(absent).toBeUndefined();
    expect(placed).toBeUndefined();
    expect(escalationView(store, escalationId)).toMatchObject({
      namespace,
      project,
      escalation: { state: "open", raisedAt: 5_000 },
    });
  });
});
