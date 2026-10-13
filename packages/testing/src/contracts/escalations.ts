import { describe, expect, it } from "@effect/vitest";
import {
  decisionIdOf,
  EFFECT_STANDS,
  escalationIdOf,
  PREMISE_HOLDS,
} from "@keeltown/core/application/coordination";
import { MAINTAINERS_AFTER_MS } from "@keeltown/core/application/memory";
import {
  type EntityRef,
  type EventEnvelope,
  Instant,
  makeId,
  type NamespaceId,
  type UserId,
} from "@keeltown/core/kernel";
import {
  type EscalationAsk,
  type EscalationRecord,
  Escalations,
  HumanGate,
  type RaiseRequest,
} from "@keeltown/core/ports";
import { Effect, type Layer } from "effect";
import { ulid } from "./probe-ledger.ts";

/**
 * The `HumanGate` and `Escalations` suites raise through the one and read and
 * rule through the other. `settled` waits until the reads show what a
 * namespace's object committed (the Projector hears it by delivery); `log`
 * reads an entity's committed events in that object.
 */
export interface EscalationsHarness {
  readonly layer: Layer.Layer<Escalations | HumanGate>;
  readonly settled: (namespace: NamespaceId) => Effect.Effect<void>;
  readonly log: (
    namespace: NamespaceId,
    entity: EntityRef,
  ) => Effect.Effect<readonly EventEnvelope[]>;
}

const types = (log: readonly EventEnvelope[]) => log.map((event) => event.type);
const ids = (items: readonly EscalationRecord[]) => items.map((item) => item.escalation.id);

const ask = (conflictId: string, question = "Which holds?"): EscalationAsk => ({
  question,
  options: [
    { id: PREMISE_HOLDS, label: "The premise holds", consequence: "the other change gives way" },
    { id: EFFECT_STANDS, label: "The effect stands", consequence: "the holder gives way" },
  ],
  about: { kind: "conflict", id: conflictId },
  category: "ambiguous-requirement",
  evidence: [{ class: "proof", summary: "a probe tells the two apart", ref: "probe:prb_1" }],
  precedents: [],
  default: PREMISE_HOLDS,
});

/** A raise for a fresh conflict in a fresh project of `namespace`, asking `sponsor` first. */
function raiseIn(namespace: NamespaceId, sponsor?: UserId): RaiseRequest {
  const conflictId = makeId("cfl", ulid());
  return {
    namespace,
    escalationId: escalationIdOf(conflictId),
    project: makeId("prj", ulid()),
    ...(sponsor === undefined ? {} : { sponsor }),
    raisedBy: `subj:${makeId("prj", ulid())}:authz.session`,
    ask: ask(conflictId),
  };
}

const escalationRef = (request: RaiseRequest): EntityRef => ({
  kind: "escalation",
  id: request.escalationId,
});

export function describeHumanGateContract(
  name: string,
  makeHarness: () => EscalationsHarness,
): void {
  describe(`HumanGate contract: ${name}`, () => {
    it.effect(
      "[t35.raise-once] an escalation raised again is the one raised first: its question and the user asked first stand, and nothing more is committed",
      () => {
        const harness = makeHarness();
        const namespace = makeId("org", ulid());
        const [first, second] = [makeId("usr", ulid()), makeId("usr", ulid())];
        const request = raiseIn(namespace, first);
        return Effect.gen(function* () {
          const gate = yield* HumanGate;
          const raised = yield* gate.raise(request);
          const again = yield* gate.raise(request);
          const other = yield* gate.raise({
            ...request,
            sponsor: second,
            raisedBy: "subj:other:authz.session",
            ask: ask(request.ask.about.id, "Another question?"),
          });
          const log = yield* harness.log(namespace, escalationRef(request));

          expect(raised).toMatchObject({
            namespace,
            project: request.project,
            sponsor: first,
            escalation: {
              id: request.escalationId,
              state: "open",
              question: "Which holds?",
              about: request.ask.about,
              default: PREMISE_HOLDS,
            },
          });
          expect(again).toEqual(raised);
          expect(other).toEqual(raised);
          expect(types(log)).toEqual(["EscalationRaised"]);
          // The raising names what it concerns: the conflict, the namespace and the user asked first.
          expect(log[0]).toMatchObject({
            project: request.project,
            affected: [
              request.ask.about,
              { kind: "org", id: namespace },
              { kind: "user", id: first },
            ],
          });
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[t35.raise-once] a question with one option, or a default it does not offer, is refused and raises nothing",
      () => {
        const harness = makeHarness();
        const namespace = makeId("org", ulid());
        const request = raiseIn(namespace);
        const [only] = request.ask.options;
        if (only === undefined) throw new Error("the ask offers options");
        return Effect.gen(function* () {
          const gate = yield* HumanGate;
          const lone = yield* Effect.flip(
            gate.raise({ ...request, ask: { ...request.ask, options: [only] } }),
          );
          const stray = yield* Effect.flip(
            gate.raise({ ...request, ask: { ...request.ask, default: "neither" } }),
          );
          expect([lone._tag, stray._tag]).toEqual(["InvalidEscalation", "InvalidEscalation"]);
          expect(yield* harness.log(namespace, escalationRef(request))).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}

export function describeEscalationsContract(
  name: string,
  makeHarness: () => EscalationsHarness,
): void {
  describe(`Escalations contract: ${name}`, () => {
    it.effect(
      "[escalations.contract] a raised escalation is read by its id with its place, and one never raised is not found",
      () => {
        const harness = makeHarness();
        const namespace = makeId("org", ulid());
        const sponsor = makeId("usr", ulid());
        const request = raiseIn(namespace, sponsor);
        return Effect.gen(function* () {
          const raised = yield* (yield* HumanGate).raise(request);
          yield* harness.settled(namespace);
          const escalations = yield* Escalations;
          const read = yield* escalations.get(request.escalationId);
          const missing = yield* Effect.flip(escalations.get(makeId("esc", ulid())));

          // The read is what was raised, with the label the feed gave it: its project's first question.
          expect(read).toEqual({ ...raised, label: "E-1" });
          expect(read).toMatchObject({ namespace, project: request.project, sponsor });
          expect(missing._tag).toBe("EscalationNotFound");
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[escalations.contract] [t67.label] each question carries Keel's label, counted in its own project in the order raised, and the read by id, the list and the ruling's answer all say the same",
      () => {
        const harness = makeHarness();
        const namespace = makeId("org", ulid());
        const by = makeId("usr", ulid());
        const project = makeId("prj", ulid());
        const first = { ...raiseIn(namespace, by), project };
        const elsewhere = raiseIn(namespace, by);
        const second = { ...raiseIn(namespace, by), project };
        return Effect.gen(function* () {
          const gate = yield* HumanGate;
          for (const request of [first, elsewhere, second]) {
            yield* gate.raise(request);
            // One at a time, so each project's count follows the order they were raised in.
            yield* harness.settled(namespace);
          }
          const escalations = yield* Escalations;
          const read = yield* Effect.forEach([first, elsewhere, second], (request) =>
            escalations.get(request.escalationId),
          );
          const listed = yield* escalations.list({
            reader: { _tag: "Project", project },
            now: Instant(0),
          });
          const ruled = yield* escalations.rule({
            escalationId: second.escalationId,
            option: PREMISE_HOLDS,
            by,
            idempotencyKey: "rule-label",
          });

          expect(read.map((record) => record.label)).toEqual(["E-1", "E-1", "E-2"]);
          expect(listed.items.map((record) => [record.escalation.id, record.label])).toEqual([
            [second.escalationId, "E-2"],
            [first.escalationId, "E-1"],
          ]);
          expect([ruled.escalation.id, ruled.label]).toEqual([second.escalationId, "E-2"]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[t35.ruling-once] a ruling is given once and records its decision with it: the same key again answers the same, another body under it is refused, and so is a second ruling",
      () => {
        const harness = makeHarness();
        const namespace = makeId("org", ulid());
        const by = makeId("usr", ulid());
        const request = raiseIn(namespace, by);
        const decisionId = decisionIdOf(request.escalationId);
        const ruling = {
          escalationId: request.escalationId,
          option: EFFECT_STANDS,
          by,
          rationale: "the session cache is the product",
          idempotencyKey: "rule-1",
        };
        return Effect.gen(function* () {
          yield* (yield* HumanGate).raise(request);
          yield* harness.settled(namespace);
          const escalations = yield* Escalations;
          const ruled = yield* escalations.rule(ruling);
          const again = yield* escalations.rule(ruling);
          const otherBody = yield* Effect.flip(
            escalations.rule({ ...ruling, option: PREMISE_HOLDS }),
          );
          const second = yield* Effect.flip(
            escalations.rule({ ...ruling, option: PREMISE_HOLDS, idempotencyKey: "rule-2" }),
          );
          yield* harness.settled(namespace);
          const read = yield* escalations.get(request.escalationId);
          const log = yield* harness.log(namespace, escalationRef(request));
          const decided = yield* harness.log(namespace, { kind: "decision", id: decisionId });

          expect(ruled).toMatchObject({
            decisionId,
            escalation: {
              state: "ruled",
              ruling: {
                option: EFFECT_STANDS,
                by: `user:${by}`,
                rationale: "the session cache is the product",
              },
            },
          });
          expect(again).toEqual(ruled);
          expect(read).toEqual(ruled);
          expect(otherBody._tag).toBe("IdempotencyConflict");
          expect(second).toMatchObject({ _tag: "EscalationStateRefused", state: "ruled" });
          expect(types(log)).toEqual(["EscalationRaised", "RulingGiven"]);
          expect(log[1]?.actor).toBe(`user:${by}`);
          // One ruling, one decision: recorded in the same commit, naming its escalation and what it is about.
          expect(decided).toHaveLength(1);
          expect(decided[0]).toMatchObject({
            type: "DecisionRecorded",
            at: log[1]?.at,
            project: request.project,
            payload: {
              decisionId,
              escalationId: request.escalationId,
              option: EFFECT_STANDS,
              summary: "The effect stands",
              alternatives: [{ option: PREMISE_HOLDS }],
            },
          });
          expect(decided[0]?.affected).toEqual(
            expect.arrayContaining([escalationRef(request), request.ask.about]),
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[t35.option-unknown] a ruling for an option the escalation does not offer, or on an escalation never raised, is refused and decides nothing",
      () => {
        const harness = makeHarness();
        const namespace = makeId("org", ulid());
        const by = makeId("usr", ulid());
        const request = raiseIn(namespace, by);
        return Effect.gen(function* () {
          yield* (yield* HumanGate).raise(request);
          yield* harness.settled(namespace);
          const escalations = yield* Escalations;
          const unknown = yield* Effect.flip(
            escalations.rule({
              escalationId: request.escalationId,
              option: "split-the-difference",
              by,
              idempotencyKey: "rule-1",
            }),
          );
          const missing = yield* Effect.flip(
            escalations.rule({
              escalationId: makeId("esc", ulid()),
              option: PREMISE_HOLDS,
              by,
              idempotencyKey: "rule-1",
            }),
          );
          yield* harness.settled(namespace);

          expect(unknown).toMatchObject({
            _tag: "RulingOptionUnknown",
            option: "split-the-difference",
          });
          expect(missing._tag).toBe("EscalationNotFound");
          expect((yield* escalations.get(request.escalationId)).escalation.state).toBe("open");
          expect(types(yield* harness.log(namespace, escalationRef(request)))).toEqual([
            "EscalationRaised",
          ]);
          expect(
            yield* harness.log(namespace, {
              kind: "decision",
              id: decisionIdOf(request.escalationId),
            }),
          ).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[t35.sponsor-then-maintainers] an escalation is listed to the user asked first at once, to its namespace's maintainers after thirty minutes or at once when nobody is asked first, and never to another namespace's",
      () => {
        const harness = makeHarness();
        const [namespace, elsewhere] = [makeId("org", ulid()), makeId("org", ulid())];
        const [sponsor, maintainer, outsider] = [
          makeId("usr", ulid()),
          makeId("usr", ulid()),
          makeId("usr", ulid()),
        ];
        const asked = raiseIn(namespace, sponsor);
        const unasked = raiseIn(namespace);
        return Effect.gen(function* () {
          const gate = yield* HumanGate;
          const first = yield* gate.raise(asked);
          yield* gate.raise(unasked);
          yield* harness.settled(namespace);
          const escalations = yield* Escalations;
          const raisedAt = first.escalation.raisedAt;
          const idsFor = (
            userId: UserId,
            maintains: readonly NamespaceId[],
            after: number,
          ): Effect.Effect<readonly string[]> =>
            escalations
              .list({
                reader: { _tag: "User", userId, maintains },
                now: Instant(raisedAt + after),
              })
              .pipe(Effect.map((page) => page.items.map((item) => item.escalation.id)));
          const mine = (listed: readonly string[]) =>
            listed.filter((id) => id === asked.escalationId || id === unasked.escalationId);

          expect(mine(yield* idsFor(sponsor, [], 0))).toEqual([asked.escalationId]);
          expect(mine(yield* idsFor(maintainer, [namespace], 0))).toEqual([unasked.escalationId]);
          expect(mine(yield* idsFor(maintainer, [namespace], MAINTAINERS_AFTER_MS - 1))).toEqual([
            unasked.escalationId,
          ]);
          // Newest first, once the maintainers' turn has come.
          expect(mine(yield* idsFor(maintainer, [namespace], MAINTAINERS_AFTER_MS))).toEqual([
            unasked.escalationId,
            asked.escalationId,
          ]);
          expect(mine(yield* idsFor(outsider, [elsewhere], MAINTAINERS_AFTER_MS * 100))).toEqual(
            [],
          );
          expect(mine(yield* idsFor(outsider, [], MAINTAINERS_AFTER_MS * 100))).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      },
    );

    it.effect(
      "[escalations.contract] an agent's list is its own project's escalations, in the state asked for, a page at a time from the newest",
      () => {
        const harness = makeHarness();
        const namespace = makeId("org", ulid());
        const by = makeId("usr", ulid());
        const project = makeId("prj", ulid());
        const requests = [
          raiseIn(namespace, by),
          raiseIn(namespace, by),
          raiseIn(namespace, by),
        ].map((request) => ({ ...request, project }));
        const foreign = raiseIn(namespace, by);
        const [oldest, middle, newest] = requests;
        if (oldest === undefined || middle === undefined || newest === undefined)
          throw new Error("three requests");
        return Effect.gen(function* () {
          const gate = yield* HumanGate;
          for (const request of [oldest, foreign, middle, newest]) {
            yield* gate.raise(request);
            // One at a time, so the order the reads show is the order they were raised in.
            yield* harness.settled(namespace);
          }
          const escalations = yield* Escalations;
          yield* escalations.rule({
            escalationId: middle.escalationId,
            option: PREMISE_HOLDS,
            by,
            idempotencyKey: "rule-1",
          });
          yield* harness.settled(namespace);
          const reader = { _tag: "Project", project } as const;
          const now = Instant(0);
          const all = yield* escalations.list({ reader, now });
          const open = yield* escalations.list({ reader, now, state: "open" });
          const ruled = yield* escalations.list({ reader, now, state: "ruled" });
          const pageOne = yield* escalations.list({ reader, now, limit: 2 });
          const pageTwo = yield* escalations.list({
            reader,
            now,
            limit: 2,
            cursor: pageOne.nextCursor,
          });

          expect(ids(all.items)).toEqual([
            newest.escalationId,
            middle.escalationId,
            oldest.escalationId,
          ]);
          expect(ids(open.items)).toEqual([newest.escalationId, oldest.escalationId]);
          expect(ids(ruled.items)).toEqual([middle.escalationId]);
          expect(ids(pageOne.items)).toEqual([newest.escalationId, middle.escalationId]);
          expect(pageOne.nextCursor).toBeDefined();
          expect(ids(pageTwo.items)).toEqual([oldest.escalationId]);
        }).pipe(Effect.provide(harness.layer));
      },
    );
  });
}
