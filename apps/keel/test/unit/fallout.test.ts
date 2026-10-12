import { describe, expect, it } from "@effect/vitest";
import {
  conflictIdOf,
  type FalloutPair,
  falloutPairs,
  hearSubject,
  HOLDER_HEARS,
  PROBE_WORKFLOW,
  subjectKeysOf,
} from "@keeltown/core/application/coordination";
import {
  declaredEffect,
  fallout,
  IntentDeclared,
  IntentRevised,
  isAncestorOrSelf,
  Proposition,
  SubjectKey,
} from "@keeltown/core/domain/coordination";
import {
  type AgentId,
  type ChangeId,
  type EventEnvelope,
  Instant,
  makeId,
} from "@keeltown/core/kernel";
import { makeEventOutboxMemory, sampleProjectId, ulidOf } from "@keeltown/testing";
import { Schema } from "effect";
import * as fc from "fast-check";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 200, ...(seed === undefined ? {} : { seed: Number(seed) }) });

const key = (value: string) => Schema.decodeUnknownSync(SubjectKey)(value);
/** A small tree: a root, two siblings under it, one beneath a sibling, and an unrelated root. */
const KEYS = [
  "authz",
  "authz.permission-evaluation",
  "authz.session",
  "authz.session.cache",
  "billing",
].map(key);

const proposition = (p: {
  subject: SubjectKey;
  predicate?: "purity";
  relation: "is" | "at-most";
  value: "per-request" | "per-session" | boolean;
  strength?: "should";
}) =>
  Schema.decodeUnknownSync(Proposition)({
    subject: p.subject,
    predicate: p.predicate ?? "freshness",
    relation: p.relation,
    value: p.value,
    ...(p.strength === undefined ? {} : { strength: p.strength }),
  });

const changeOf = (i: number): ChangeId => makeId("chg", ulidOf(1 + i));
const agentOf = (i: number): AgentId => makeId("agt", ulidOf(21 + i));

/** A change's IntentDeclared, as its Change DO commits it. */
const declaredEnvelope = (
  i: number,
  premises: readonly Proposition[],
  declaredEffects: readonly Proposition[],
): EventEnvelope => ({
  eventId: makeId("evt", ulidOf(100 + i)),
  type: "IntentDeclared",
  entity: { kind: "change", id: changeOf(i) },
  seq: 1,
  at: Instant(Date.UTC(2026, 9, 12)),
  dedupeKey: `declare-${i}`,
  affected: [],
  notified: [],
  payload: Schema.encodeSync(IntentDeclared)(
    IntentDeclared.make({
      changeId: changeOf(i),
      agentId: agentOf(i),
      origin: "agent",
      revision: 1,
      goal: `change ${i}`,
      footprint: [],
      premises,
      declaredEffects,
      leaseId: makeId("lse", ulidOf(200 + i)),
    }),
  ),
});

/** A change's IntentRevised, retracting and adding premises, as its Change DO commits it. */
const revisedEnvelope = (
  i: number,
  revision: number,
  change: { added?: readonly Proposition[]; retracted?: readonly Proposition[] },
): EventEnvelope => ({
  eventId: makeId("evt", ulidOf(300 + i * 10 + revision)),
  type: "IntentRevised",
  entity: { kind: "change", id: changeOf(i) },
  seq: revision,
  at: Instant(Date.UTC(2026, 9, 12)),
  dedupeKey: `revise-${i}-${revision}`,
  affected: [],
  notified: [],
  payload: Schema.encodeSync(IntentRevised)(
    IntentRevised.make({
      changeId: changeOf(i),
      revision,
      premisesAdded: change.added ?? [],
      premisesRetracted: change.retracted ?? [],
    }),
  ),
});

/** One Subject DO per key, in memory, each hearing what the fan-out would deliver it. */
function subjects() {
  const objects = new Map<SubjectKey, ReturnType<typeof makeEventOutboxMemory>>();
  const objectAt = (at: SubjectKey) => {
    let object = objects.get(at);
    if (object === undefined) {
      object = makeEventOutboxMemory();
      objects.set(at, object);
    }
    return object;
  };
  /** Delivers a change's declare to every subject it names and their ancestors; answers what each committed. */
  const declare = (envelope: EventEnvelope) => {
    const declared = Schema.decodeUnknownSync(IntentDeclared)(envelope.payload);
    return subjectKeysOf(declared).flatMap((at) => {
      const { store, service: outbox } = objectAt(at);
      const reaction = store.service.transaction(() =>
        hearSubject({ store: store.service, outbox }, sampleProjectId, at, envelope),
      );
      return reaction.drafts.map((draft) => ({ at, draft }));
    });
  };
  /** Delivers any event of a change to the subjects at `keys`; answers what each committed. */
  const deliver = (keys: readonly SubjectKey[], envelope: EventEnvelope) =>
    keys.flatMap((at) => {
      const { store, service: outbox } = objectAt(at);
      return store.service
        .transaction(() =>
          hearSubject({ store: store.service, outbox }, sampleProjectId, at, envelope),
        )
        .drafts.map((draft) => ({ at, draft }));
    });
  return { declare, deliver, objectAt };
}

type Intent = { readonly premises: Proposition[]; readonly effects: Proposition[] };

/** The conflicts fallout owes a set of intents: each premise against each other change's effect, related ancestor-or-self. */
const owed = (intents: readonly Intent[]): readonly string[] =>
  intents.flatMap((holder, h) =>
    intents.flatMap((other, c) =>
      c === h
        ? []
        : holder.premises.flatMap((premise) =>
            other.effects
              .filter(
                (effect) =>
                  isAncestorOrSelf(premise.subject, effect.subject) ||
                  isAncestorOrSelf(effect.subject, premise.subject),
              )
              .filter((effect) =>
                fallout(
                  changeOf(c),
                  declaredEffect(effect),
                  [{ holder: changeOf(h), proposition: premise }],
                  [],
                ).some((outcome) => outcome._tag === "conflict"),
              )
              .map((effect) => {
                const pair: FalloutPair = {
                  premise: { holder: changeOf(h), proposition: premise },
                  effect: { changeId: changeOf(c), proposition: effect },
                };
                return conflictIdOf(sampleProjectId, pair);
              }),
          ),
    ),
  );

const opened = (heard: readonly { draft: { payload: { _tag: string } } }[]) =>
  heard
    .filter(({ draft }) => draft.payload._tag === "ConflictSuspected")
    .map(({ draft }) => String(Reflect.get(draft.payload, "conflictId")));

/** A freshness claim or a purity one: two predicates of one subject touch it, and neither disputes the other. */
const arbitraryClaim = fc.oneof(
  fc.record({
    relation: fc.constantFrom("is" as const, "at-most" as const),
    value: fc.constantFrom("per-request" as const, "per-session" as const),
  }),
  fc.record({
    predicate: fc.constant("purity" as const),
    relation: fc.constant("is" as const),
    value: fc.boolean(),
  }),
);
const arbitraryProposition = fc
  .record(
    {
      subject: fc.constantFrom(...KEYS),
      claim: arbitraryClaim,
      strength: fc.constantFrom("should" as const),
    },
    { requiredKeys: ["subject", "claim"] },
  )
  .map(({ claim, ...rest }) => ({ ...rest, ...claim }));
const arbitraryIntent = fc.record({
  premises: fc.array(arbitraryProposition.map(proposition), { maxLength: 2 }),
  effects: fc.array(
    arbitraryProposition.map((p) => proposition({ ...p, relation: "is" })),
    { maxLength: 2 },
  ),
});
const arbitraryIntents = fc.array(arbitraryIntent, { minLength: 2, maxLength: 4 });

/** What a subject holds of change `i`, as `falloutPairs` reads it. */
const heldBy = (i: number, intent: Intent) => ({
  changeId: changeOf(i),
  premises: intent.premises,
  declaredEffects: intent.effects,
});

/** The suspicions and conflicts among what subjects committed: what fallout tells anyone. */
const told = (heard: readonly { draft: { payload: { _tag: string } } }[]) =>
  heard
    .map(({ draft }) => draft.payload._tag)
    .filter((tag) => tag === "ConflictSuspected" || tag === "PremiseSuspected");

describe("[b21.fallout-proximity] fallout opens a conflict only where the domain finds one", () => {
  it("[b21.fallout-proximity] [b21.fallout-siblings] [b21.conflict-subject-key] any intents declared in any order: exactly the conflicts fallout owes, each once, at one subject, siblings never", () => {
    fc.assert(
      fc.property(arbitraryIntents, fc.func(fc.nat()), (intents, order) => {
        const s = subjects();
        const sequence = intents
          .map((_, i) => i)
          .toSorted((a, b) => (order(a) % 7) - (order(b) % 7) || a - b);
        const heard = sequence.flatMap((i) =>
          s.declare(declaredEnvelope(i, intents[i]?.premises ?? [], intents[i]?.effects ?? [])),
        );
        // Every conflict a subject opens names the subject's own key.
        const suspected = heard.filter(({ draft }) => draft.payload._tag === "ConflictSuspected");
        expect(suspected.map(({ draft }) => Reflect.get(draft.payload, "subjectKey"))).toEqual(
          suspected.map(({ at }) => at),
        );
        // A claim repeated in one intent is one claim: owed once. What opened stays as committed.
        expect(opened(heard).toSorted()).toEqual([...new Set(owed(intents))].toSorted());
      }),
    );
  });

  it("[b21.fallout-siblings] the pairs a subject judges have one side at its own key and the other at or under it: siblings and cousins beneath it never pair", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KEYS),
        arbitraryIntent,
        fc.array(arbitraryIntent, { minLength: 1, maxLength: 3 }),
        (at, mine, others) => {
          const pairs = falloutPairs(
            at,
            {
              changeId: changeOf(0),
              before: heldBy(0, { premises: [], effects: [] }),
              after: heldBy(0, mine),
            },
            others.map((other, i) => heldBy(i + 1, other)),
          );
          // The shorter key of each pair, or that its two subjects are unrelated.
          const judgedAt = pairs.map(({ premise, effect }) => {
            const p = premise.proposition.subject;
            const e = effect.proposition.subject;
            if (isAncestorOrSelf(p, e)) return p;
            return isAncestorOrSelf(e, p) ? e : `${p} and ${e} are unrelated`;
          });
          expect(judgedAt).toEqual(pairs.map(() => at));
        },
      ),
    );
  });

  it("[b21.fallout-proximity] [b21.fallout-siblings] proximity alone tells nobody: another predicate of the same subject, and a contradiction between siblings", () => {
    const s = subjects();
    const leaf = key("authz.permission-evaluation");
    s.declare(
      declaredEnvelope(
        0,
        [proposition({ subject: leaf, relation: "at-most", value: "per-request" })],
        [],
      ),
    );
    const touched = s.declare(
      declaredEnvelope(
        1,
        [],
        [proposition({ subject: leaf, predicate: "purity", relation: "is", value: false })],
      ),
    );
    const sibling = s.declare(
      declaredEnvelope(
        2,
        [],
        [proposition({ subject: key("authz.session"), relation: "is", value: "per-session" })],
      ),
    );
    expect(told([...touched, ...sibling])).toEqual([]);
  });

  it("[b21.fallout-proximity] [b21.premise-suspected] a should premise its neighbour's effect contradicts is suspected, not a conflict, and its holder's agent is told", () => {
    const s = subjects();
    const leaf = key("authz.permission-evaluation");
    const premise = proposition({
      subject: leaf,
      relation: "at-most",
      value: "per-request",
      strength: "should",
    });
    const effect = proposition({ subject: leaf, relation: "is", value: "per-session" });
    s.declare(declaredEnvelope(0, [premise], []));
    const heard = s.declare(declaredEnvelope(1, [], [effect]));
    expect(opened(heard)).toEqual([]);
    expect(heard.filter(({ draft }) => draft.payload._tag === "PremiseSuspected")).toMatchObject([
      {
        at: leaf,
        draft: {
          payload: { changeId: changeOf(0), cause: { changeId: changeOf(1) } },
          affected: [{ kind: "change", id: changeOf(0) }],
        },
      },
    ]);
    const about = {
      entity: { kind: "subject" as const, id: "x" },
      affected: [{ kind: "change" as const, id: changeOf(0) }],
    };
    expect(s.objectAt(leaf).service.subscribers(HOLDER_HEARS[0], about)).toContain(
      `agent:${agentOf(0)}`,
    );
  });

  it("[b21.fallout-proximity] [b21.premise-suspected] a pair is judged once: a premise retracted and relied on again is not suspected again", () => {
    const s = subjects();
    const leaf = key("authz.permission-evaluation");
    const premise = proposition({
      subject: leaf,
      relation: "at-most",
      value: "per-request",
      strength: "should",
    });
    const effect = proposition({ subject: leaf, relation: "is", value: "per-session" });
    s.declare(declaredEnvelope(0, [premise], []));
    const first = s.declare(declaredEnvelope(1, [], [effect]));
    const keys = [leaf, key("authz")];
    s.deliver(keys, revisedEnvelope(0, 2, { retracted: [premise] }));
    const again = s.deliver(keys, revisedEnvelope(0, 3, { added: [premise] }));
    const suspicions = (heard: typeof first) =>
      heard.filter(({ draft }) => draft.payload._tag === "PremiseSuspected");
    expect(suspicions(first)).toHaveLength(1);
    expect(suspicions(again)).toEqual([]);
  });

  it("[b21.fallout-race] the effect first, then the premise: the same conflict, judged once, and the Probe Workflow subscribed", () => {
    const leaf = key("authz.permission-evaluation");
    const premise = proposition({ subject: leaf, relation: "at-most", value: "per-request" });
    const effect = proposition({ subject: leaf, relation: "is", value: "per-session" });
    const premiseFirst = subjects();
    premiseFirst.declare(declaredEnvelope(0, [premise], []));
    const one = opened(premiseFirst.declare(declaredEnvelope(1, [], [effect])));
    const effectFirst = subjects();
    effectFirst.declare(declaredEnvelope(1, [], [effect]));
    const other = opened(effectFirst.declare(declaredEnvelope(0, [premise], [])));
    expect(one).toHaveLength(1);
    expect(other).toEqual(one);
    for (const s of [premiseFirst, effectFirst])
      expect(s.objectAt(leaf).service.subscribers("ConflictSuspected")).toContain(PROBE_WORKFLOW);
  });
});
