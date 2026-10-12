import { describe, expect, it } from "@effect/vitest";
import {
  conflictIdOf,
  falloutPairs,
  hearSubject,
  HOLDER_HEARS,
  PROBE_WORKFLOW,
  subjectIdOf,
  subjectKeysOf,
} from "@keeltown/core/application/coordination";
import {
  claimKey,
  declaredEffect,
  type DerivedEffect,
  EffectsDerived,
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
  CommitSha,
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

const HEAD = Schema.decodeUnknownSync(CommitSha)("c".repeat(40));

/**
 * An effect as Precheck derives it: an extractor's ruling unless it is clef's
 * opinion, anchored in the head commit, which no declared proposition here is.
 */
const derivedEffect = (p: {
  subject: SubjectKey;
  value: "per-request" | "per-session";
  method?: "extractor" | "clef";
}): DerivedEffect => {
  const anchors = [{ path: `src/${p.subject}.ts`, symbol: "read", commit: HEAD }];
  const found = {
    proposition: {
      ...proposition({ subject: p.subject, relation: "is", value: p.value }),
      anchors,
    },
    anchors,
    declared: false,
  };
  return p.method === "clef"
    ? { ...found, method: "clef", evidenceClass: "opinion", p: 0.8 }
    : { ...found, method: "extractor", evidenceClass: "ruling" };
};

/** A change's EffectsDerived at `seq` on its log, as its Change DO commits it. */
const derivedEnvelope = (
  i: number,
  seq: number,
  effects: readonly DerivedEffect[],
  revision = 1,
): EventEnvelope => ({
  eventId: makeId("evt", ulidOf(600 + i * 20 + seq)),
  type: "EffectsDerived",
  entity: { kind: "change", id: changeOf(i) },
  seq,
  at: Instant(Date.UTC(2026, 9, 12)),
  dedupeKey: `derive-${i}-${seq}`,
  affected: [],
  notified: [],
  payload: Schema.encodeSync(EffectsDerived)(
    EffectsDerived.make({
      changeId: changeOf(i),
      revision,
      effects,
      derivationRef: `derivation-${i}-${seq}`,
    }),
  ),
});

/** The subjects that hear a change's derivation of these effects: each effect's, and its ancestors. */
const derivedKeys = (effects: readonly DerivedEffect[]) =>
  subjectKeysOf({ premises: [], declaredEffects: effects.map((effect) => effect.proposition) });

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
              .map((effect) =>
                conflictIdOf(sampleProjectId, {
                  premise: { holder: changeOf(h), proposition: premise },
                  effect: { changeId: changeOf(c), proposition: effect },
                }),
              ),
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
  derived: [],
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

/** Each conflict that opened, with its origin. */
const openedAs = (heard: readonly { draft: { payload: { _tag: string } } }[]) =>
  heard
    .filter(({ draft }) => draft.payload._tag === "ConflictSuspected")
    .map(
      ({ draft }) =>
        `${String(Reflect.get(draft.payload, "conflictId"))} ${String(Reflect.get(draft.payload, "origin"))}`,
    );

/** A change's story: its intent, and what each of its Precheck passes derived, in the order of its log. */
type Story = { readonly intent: Intent; readonly passes: readonly (readonly DerivedEffect[])[] };
/** Where on the change's log pass `k` recorded its derivation. */
const seqOfPass = (k: number) => 5 + 4 * k;

const arbitraryDerived = fc
  .record({
    subject: fc.constantFrom(...KEYS),
    value: fc.constantFrom("per-request" as const, "per-session" as const),
    method: fc.constantFrom("extractor" as const, "clef" as const),
  })
  .map(derivedEffect);
const arbitraryStory: fc.Arbitrary<Story> = fc.record({
  intent: arbitraryIntent,
  passes: fc.array(fc.array(arbitraryDerived, { maxLength: 2 }), { maxLength: 2 }),
});

describe("[b21.fallout-derived] a derived effect is judged like a declared one", () => {
  it("[b21.fallout-derived] any declares and derivations heard in any order: exactly the conflicts owed by what was held together, each once, a claim declared and derived one conflict", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryStory, { minLength: 2, maxLength: 3 }),
        fc.func(fc.nat()),
        (stories, order) => {
          const s = subjects();
          const events = stories.flatMap((story, i) => [
            { i, pass: -1 },
            ...story.passes.map((_, pass) => ({ i, pass })),
          ]);
          const sequence = events
            .map((_, n) => n)
            .toSorted((a, b) => (order(a) % 7) - (order(b) % 7) || a - b)
            .flatMap((n) => events[n] ?? []);
          // What every change holds, as one timeline: a premise and an effect held together are judged.
          const held = stories.map(() => ({ declared: false, pass: -1 }));
          const owedAs = new Map<string, string>();
          const heard = sequence.flatMap(({ i, pass }) => {
            const story = stories[i];
            const now = held[i];
            if (story === undefined || now === undefined) return [];
            let committed: ReturnType<typeof s.declare>;
            if (pass < 0) {
              now.declared = true;
              committed = s.declare(
                declaredEnvelope(i, story.intent.premises, story.intent.effects),
              );
            } else {
              now.pass = Math.max(now.pass, pass);
              // Every subject the change had subscribed by then hears it: its intent's, and each derivation's so far.
              const keys = new Set([
                ...subjectKeysOf({
                  premises: story.intent.premises,
                  declaredEffects: story.intent.effects,
                }),
                ...story.passes.slice(0, pass + 1).flatMap(derivedKeys),
              ]);
              committed = s.deliver(
                [...keys],
                derivedEnvelope(i, seqOfPass(pass), story.passes[pass] ?? []),
              );
            }
            stories.forEach((holder, h) => {
              if (held[h]?.declared !== true) return;
              stories.forEach((other, c) => {
                const theirs = held[c];
                if (c === h || theirs === undefined) return;
                const declared = theirs.declared ? other.intent.effects : [];
                const derived = other.passes[theirs.pass] ?? [];
                for (const premise of holder.intent.premises)
                  for (const effect of [...declared, ...derived.map((d) => d.proposition)]) {
                    const related =
                      isAncestorOrSelf(premise.subject, effect.subject) ||
                      isAncestorOrSelf(effect.subject, premise.subject);
                    const conflicts = fallout(
                      changeOf(c),
                      declaredEffect(effect),
                      [{ holder: changeOf(h), proposition: premise }],
                      [],
                    ).some((outcome) => outcome._tag === "conflict");
                    if (!related || !conflicts) continue;
                    const conflictId = conflictIdOf(sampleProjectId, {
                      premise: { holder: changeOf(h), proposition: premise },
                      effect: { changeId: changeOf(c), proposition: effect },
                    });
                    if (owedAs.has(conflictId)) continue;
                    // The agent's own claim, or a ruling, opens as fallout; only a model's opinion alone as opinion.
                    const claim = claimKey(effect);
                    const firm =
                      declared.some((p) => claimKey(p) === claim) ||
                      derived.some(
                        (d) => d.evidenceClass !== "opinion" && claimKey(d.proposition) === claim,
                      );
                    owedAs.set(conflictId, firm ? "fallout" : "opinion");
                  }
              });
            });
            return committed;
          });
          expect(openedAs(heard).toSorted()).toEqual(
            [...owedAs].map(([conflictId, origin]) => `${conflictId} ${origin}`).toSorted(),
          );
        },
      ),
    );
  });

  const leaf = key("authz.permission-evaluation");
  const relied = proposition({ subject: leaf, relation: "at-most", value: "per-request" });

  it("[b21.fallout-derived] [b21.derived-mint] a subject the intent never named hears the derivation: it is minted from the effect and opens the conflict with the premise it holds", () => {
    const s = subjects();
    const session = key("authz.session");
    s.declare(
      declaredEnvelope(
        0,
        [proposition({ subject: session, relation: "at-most", value: "per-request" })],
        [],
      ),
    );
    // Change 1 names billing only; what its code does to the session's cache is derived.
    s.declare(
      declaredEnvelope(
        1,
        [],
        [proposition({ subject: key("billing"), relation: "is", value: "per-request" })],
      ),
    );
    // Compatible with the premise above it, so it opens nothing; it only gets its subject minted.
    const cache = derivedEffect({
      subject: key("authz.session.cache"),
      value: "per-request",
      method: "clef",
    });
    const stale = derivedEffect({ subject: session, value: "per-session" });
    const heard = s.deliver(derivedKeys([cache, stale]), derivedEnvelope(1, 5, [cache, stale]));
    expect(heard.filter(({ draft }) => draft.payload._tag === "SubjectMinted")).toMatchObject([
      {
        at: key("authz.session.cache"),
        draft: {
          payload: {
            subjectId: subjectIdOf(sampleProjectId, key("authz.session.cache")),
            anchors: cache.anchors,
            mintedBy: "clef",
          },
        },
      },
    ]);
    expect(heard.filter(({ draft }) => draft.payload._tag === "ConflictSuspected")).toMatchObject([
      {
        at: session,
        draft: {
          payload: {
            parties: [changeOf(0), changeOf(1)],
            subjectKey: session,
            origin: "fallout",
            premise: { holder: changeOf(0) },
            effect: { changeId: changeOf(1), proposition: { anchors: stale.anchors } },
          },
        },
      },
    ]);
    expect(s.objectAt(session).service.subscribers("ConflictSuspected")).toContain(PROBE_WORKFLOW);
  });

  it("[b21.fallout-derived] the premise second: a premise declared after the derivation meets the derived effect", () => {
    const s = subjects();
    const effect = derivedEffect({ subject: leaf, value: "per-session" });
    s.deliver(derivedKeys([effect]), derivedEnvelope(1, 5, [effect]));
    expect(opened(s.declare(declaredEnvelope(0, [relied], [])))).toEqual([
      conflictIdOf(sampleProjectId, {
        premise: { holder: changeOf(0), proposition: relied },
        effect: { changeId: changeOf(1), proposition: effect.proposition },
      }),
    ]);
  });

  it("[b21.fallout-derived] [b21.derivation-order] an earlier derivation arriving late is ignored: what the later one dropped is not judged", () => {
    const s = subjects();
    s.declare(declaredEnvelope(0, [relied], []));
    const dropped = derivedEffect({ subject: leaf, value: "per-session" });
    const keys = derivedKeys([dropped]);
    // The later pass derived nothing at the leaf, and it arrived first.
    const later = s.deliver(keys, derivedEnvelope(1, 9, []));
    const late = s.deliver(keys, derivedEnvelope(1, 5, [dropped]));
    expect(told([...later, ...late])).toEqual([]);
  });

  it("[b21.fallout-derived] [b21.derivation-order] two passes at one revision: the second's effects replace the first's", () => {
    const s = subjects();
    const session = key("authz.session");
    const first = derivedEffect({ subject: leaf, value: "per-session" });
    const second = derivedEffect({ subject: session, value: "per-session" });
    // A bounced change resubmitted with new code keeps its revision: both passes are revision 1.
    s.deliver(derivedKeys([first]), derivedEnvelope(1, 5, [first], 1));
    s.deliver(derivedKeys([first, second]), derivedEnvelope(1, 9, [second], 1));
    const onFirst = s.declare(declaredEnvelope(0, [relied], []));
    const onSecond = s.declare(
      declaredEnvelope(
        2,
        [proposition({ subject: session, relation: "at-most", value: "per-request" })],
        [],
      ),
    );
    expect(opened(onFirst)).toEqual([]);
    expect(opened(onSecond)).toHaveLength(1);
  });

  it("[b21.fallout-derived] a claim both declared and derived is one pair: the derivation of what the agent declared opens nothing more", () => {
    const s = subjects();
    const declared = proposition({ subject: leaf, relation: "is", value: "per-session" });
    s.declare(declaredEnvelope(0, [relied], []));
    const first = s.declare(declaredEnvelope(1, [], [declared]));
    const same = derivedEffect({ subject: leaf, value: "per-session" });
    const again = s.deliver(derivedKeys([same]), derivedEnvelope(1, 5, [same]));
    expect(opened(first)).toHaveLength(1);
    expect(told(again)).toEqual([]);
  });
});

describe("[b21.pair-identity] a pair is the claims it sets against each other, and how firmly the premise is held", () => {
  const leaf = key("authz.permission-evaluation");
  const effect = proposition({ subject: leaf, relation: "is", value: "per-session" });
  const keys = [leaf, key("authz")];

  it("[b21.pair-identity] a premise relied on again with new anchors is the same pair: no second conflict for one disagreement", () => {
    const s = subjects();
    const premise = proposition({ subject: leaf, relation: "at-most", value: "per-request" });
    const anchored = {
      ...premise,
      anchors: [{ path: "src/authz/evaluate.ts", symbol: "evaluate", commit: HEAD }],
    };
    s.declare(declaredEnvelope(0, [premise], []));
    const first = s.declare(declaredEnvelope(1, [], [effect]));
    const again = s.deliver(
      keys,
      revisedEnvelope(0, 2, { retracted: [premise], added: [anchored] }),
    );
    expect(opened(first)).toHaveLength(1);
    expect(told(again)).toEqual([]);
  });

  it("[b21.pair-identity] a should premise raised to must is judged again: the suspicion becomes a conflict", () => {
    const s = subjects();
    const should = proposition({
      subject: leaf,
      relation: "at-most",
      value: "per-request",
      strength: "should",
    });
    const must = proposition({ subject: leaf, relation: "at-most", value: "per-request" });
    s.declare(declaredEnvelope(0, [should], []));
    const first = s.declare(declaredEnvelope(1, [], [effect]));
    const raised = s.deliver(keys, revisedEnvelope(0, 2, { retracted: [should], added: [must] }));
    expect([told(first), told(raised)]).toEqual([["PremiseSuspected"], ["ConflictSuspected"]]);
  });
});

/** The origin of each conflict that opened. */
const originsOf = (heard: readonly { draft: { payload: { _tag: string } } }[]) =>
  heard
    .filter(({ draft }) => draft.payload._tag === "ConflictSuspected")
    .map(({ draft }) => Reflect.get(draft.payload, "origin"));

describe("[b21.derived-origin] a conflict's origin is the evidence class of the effect it was judged on", () => {
  const leaf = key("authz.permission-evaluation");
  const relied = proposition({ subject: leaf, relation: "at-most", value: "per-request" });
  it("[b21.derived-origin] clef's effect opens as opinion, an extractor's as fallout", () => {
    const origins = (["clef", "extractor"] as const).map((method) => {
      const s = subjects();
      s.declare(declaredEnvelope(0, [relied], []));
      const effect = derivedEffect({ subject: leaf, value: "per-session", method });
      return originsOf(s.deliver(derivedKeys([effect]), derivedEnvelope(1, 5, [effect])));
    });
    expect(origins).toEqual([["opinion"], ["fallout"]]);
  });

  it("[b21.derived-origin] a claim the agent declared stays its own testimony when clef derives it too, and a ruling stands ahead of an opinion of the same claim", () => {
    const opinion = derivedEffect({ subject: leaf, value: "per-session", method: "clef" });
    const ruling = derivedEffect({ subject: leaf, value: "per-session" });
    const declaredToo = subjects();
    declaredToo.declare(
      declaredEnvelope(
        1,
        [],
        [proposition({ subject: leaf, relation: "is", value: "per-session" })],
      ),
    );
    declaredToo.deliver(derivedKeys([opinion]), derivedEnvelope(1, 5, [opinion]));
    const both = subjects();
    both.deliver(derivedKeys([opinion, ruling]), derivedEnvelope(1, 5, [opinion, ruling]));
    expect([
      originsOf(declaredToo.declare(declaredEnvelope(0, [relied], []))),
      originsOf(both.declare(declaredEnvelope(0, [relied], []))),
    ]).toEqual([["fallout"], ["fallout"]]);
  });
});
