import { describe, expect, it } from "@effect/vitest";
import {
  ALT_SHOWN,
  hearLiveChange,
  LIVE_ANCHOR,
  LIVE_CHANGE,
  LIVE_CLAIM,
  LIVE_FOOTPRINT,
  LIVE_SUBJECT,
  liveChanges,
  liveNear,
} from "@keeltown/core/application/coordination";
import {
  AlternativeDeclared,
  AlternativeLanded,
  anchorPathsOf,
  areAlternatives,
  exposure,
  Intent,
  intentPropositions,
  IntentRevised,
  isAncestorOrSelf,
  type LiveChange,
  livePropositions,
  parentSubject,
  reviseIntent,
  subjectAncestors,
} from "@keeltown/core/domain/coordination";
import { type ChangeId, EventEnvelope, literalPrefix, makeId } from "@keeltown/core/kernel";
import type { EntityStore, EventDraft, Stored } from "@keeltown/core/ports";
import { makeEventOutboxMemory, sampleProjectId, ulidOf } from "@keeltown/testing";
import { Schema } from "effect";
import * as fc from "fast-check";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 300, ...(seed === undefined ? {} : { seed: Number(seed) }) });

/** A property of many folds and reads takes a few seconds alone and several more in the whole suite under load. */
const PROPERTY_TIMEOUT = 60_000;

type Store = EntityStore["Service"];
type Json = { readonly [key: string]: unknown };

const decodeIntent = Schema.decodeUnknownSync(Intent);
const changeOf = (i: number): ChangeId => makeId("chg", ulidOf(1 + i));
/** A change the index never heard of, as a change is at its own declare. */
const OUTSIDER = changeOf(99);
const KEY_KINDS = [LIVE_SUBJECT, LIVE_FOOTPRINT, LIVE_ANCHOR, LIVE_CLAIM] as const;

// The alphabets of exposure's own properties (core's test arbitraries), widened where a key row
// has a rule of its own: globs that start with a wildcard, sit under one another or hold the
// characters a key escapes, and claim sets that meet in any order.

/** Two tops, three mids, two leaves, one to three deep, so related, sibling and cousin subjects meet often. */
const subjectArb = fc
  .tuple(
    fc.constantFrom("authz", "billing"),
    fc.constantFrom("permission-evaluation", "cache", "audit-log"),
    fc.constantFrom("read", "write"),
    fc.integer({ min: 1, max: 3 }),
  )
  .map(([a, b, c, depth]) => [a, b, c].slice(0, depth).join("."));

/** A freshness premise and the effect that breaks it, and presence either way. */
const CLAIMS = [
  { predicate: "freshness", relation: "at-most", value: "per-request" },
  { predicate: "freshness", relation: "is", value: "per-session" },
  { predicate: "presence", relation: "is", value: true },
  { predicate: "presence", relation: "not", value: true },
] as const;

/** Anchor paths, two of them spelled with the characters a key row escapes. */
const ANCHORS = ["src/authz/check.ts", "src/billing/charge.ts", "src/a|b.ts", "src/a%7Cb.ts"];
const anchored = (paths: readonly string[]) =>
  paths.length === 0 ? {} : { anchors: paths.map((path) => ({ path, commit: "a".repeat(40) })) };

const propositionArb: fc.Arbitrary<Json> = fc
  .record({
    subject: subjectArb,
    claim: fc.constantFrom(...CLAIMS),
    anchors: fc.subarray(ANCHORS, { maxLength: 1 }),
    strength: fc.constantFrom("must", "should"),
  })
  .map(({ subject, claim, anchors, strength }) => ({
    subject,
    ...claim,
    strength,
    ...anchored(anchors),
  }));

/** Three claims an intent's declared effects may share with another's, so alternatives meet. */
const POOL = [
  { subject: "authz.cache", ...CLAIMS[1] },
  { subject: "billing", ...CLAIMS[2] },
  { subject: "authz.permission-evaluation.read", ...CLAIMS[0] },
];

/** Some of the pool's claims, in any order, one maybe repeated, each with anchors of its own. */
const claimSetArb: fc.Arbitrary<Json[]> = fc
  .tuple(fc.shuffledSubarray(POOL), fc.boolean(), fc.subarray(ANCHORS, { maxLength: 1 }))
  .map(([picked, repeat, anchors]) =>
    [...picked, ...(repeat ? picked.slice(0, 1) : [])].map((claim) => ({
      ...claim,
      ...anchored(anchors),
    })),
  );

const effectsArb = fc.oneof(fc.array(propositionArb, { maxLength: 2 }), claimSetArb);

/** Globs from a small alphabet, with a leading or doubled `/` too. */
const globArb = fc
  .tuple(
    fc.array(
      fc.constantFrom("src", "authz", "billing", "a|b", "a%7Cb", "*", "**", "*.ts", "check.ts"),
      { minLength: 1, maxLength: 4 },
    ),
    fc.constantFrom("", "/"),
    fc.boolean(),
  )
  .map(([segments, lead, doubled]) => lead + segments.join(doubled ? "//" : "/"));

const footprintArb = fc.array(
  globArb.map((path) => ({ path, op: "edit" })),
  { maxLength: 2 },
);

const intentArb = fc.record({
  goal: fc.constantFrom("speed up permission checks", "bill per seat"),
  footprint: footprintArb,
  premises: fc.array(propositionArb, { maxLength: 2 }),
  declaredEffects: effectsArb,
});

/** One live change's life: declared, maybe revised, maybe derived for, maybe ended. */
const planArb = fc.record({
  intent: intentArb,
  revision: fc.option(
    fc.record({
      footprint: fc.option(footprintArb, { nil: undefined }),
      premisesAdded: fc.array(propositionArb, { maxLength: 1 }),
      retractFirst: fc.boolean(),
      declaredEffects: fc.option(effectsArb, { nil: undefined }),
    }),
    { nil: undefined },
  ),
  derived: fc.option(fc.array(propositionArb, { minLength: 1, maxLength: 2 }), { nil: undefined }),
  end: fc.constantFrom(undefined, undefined, "ChangeLanded", "ChangeWithdrawn"),
});

const worldArb = fc.array(planArb, { minLength: 1, maxLength: 6 }).chain((plans) =>
  fc.record({
    plans: fc.constant(plans),
    order: fc.shuffledSubarray(
      plans.map((_, i) => i),
      { minLength: plans.length },
    ),
    probes: fc.array(intentArb, { maxLength: 2 }),
  }),
);
type World = typeof worldArb extends fc.Arbitrary<infer W> ? W : never;

let seq = 0;
/** An event of `changeId`, as the fan-out delivers it to the Project DO. */
const eventOf = (changeId: ChangeId, payload: Json & { readonly _tag: string }) => {
  seq += 1;
  return Schema.decodeUnknownSync(EventEnvelope)({
    eventId: makeId("evt", ulidOf(seq)),
    type: payload._tag,
    entity: { kind: "change", id: changeId },
    seq,
    at: Date.UTC(2026, 9, 14),
    dedupeKey: `change:${changeId}/cause-${seq}/${payload._tag}#1`,
    affected: [],
    notified: [],
    payload,
  });
};

const declared = (i: number, intent: Json) =>
  eventOf(changeOf(i), {
    _tag: "IntentDeclared",
    changeId: changeOf(i),
    agentId: makeId("agt", ulidOf(1 + i)),
    origin: "agent",
    revision: 1,
    leaseId: makeId("lse", ulidOf(1 + i)),
    ...intent,
  });
const ended = (changeId: ChangeId, type: string) =>
  eventOf(changeId, { _tag: type, changeId, by: "agent" });

/** A project's index on a memory store, folded by the Project DO's own `hearLiveChange`. */
function index(store = makeEventOutboxMemory()) {
  const hear = (event: EventEnvelope): readonly EventDraft[] =>
    store.store.service.transaction(() =>
      hearLiveChange({ store: store.store.service, outbox: store.service }, sampleProjectId, event),
    );
  return { store: store.store.service, hear };
}

/** Folds every change of the world into `index`: its declare in the world's order, then its revision and derivation. */
function fold(world: World, into: ReturnType<typeof index>) {
  for (const i of world.order) into.hear(declared(i, world.plans[i]?.intent ?? {}));
  world.plans.forEach((plan, i) => {
    const changeId = changeOf(i);
    if (plan.revision !== undefined) {
      const { retractFirst, footprint, declaredEffects, premisesAdded } = plan.revision;
      into.hear(
        eventOf(changeId, {
          _tag: "IntentRevised",
          changeId,
          revision: 2,
          premisesAdded,
          premisesRetracted: retractFirst ? plan.intent.premises.slice(0, 1) : [],
          ...(footprint === undefined ? {} : { footprint }),
          ...(declaredEffects === undefined ? {} : { declaredEffects }),
        }),
      );
    }
    if (plan.derived !== undefined)
      into.hear(
        eventOf(changeId, {
          _tag: "EffectsDerived",
          changeId,
          revision: 2,
          effects: plan.derived.map((proposition) => ({
            proposition,
            method: "extractor",
            evidenceClass: "ruling",
            anchors: [{ path: "src/authz/cache.ts", commit: "c".repeat(40) }],
            declared: false,
          })),
          derivationRef: `derive-${i}`,
        }),
      );
  });
}

const keyRowsOf = (store: Store) => KEY_KINDS.map((kind) => store.list(kind));

/** A store holding only these live-change rows, as a Project DO did before the key rows. */
function beforeKeys(rows: readonly { readonly id: string; readonly value: Stored }[]) {
  const store = makeEventOutboxMemory();
  for (const { id, value } of rows) store.store.service.put(LIVE_CHANGE, id, value);
  return index(store);
}

/** The key rows the index would hold were it built afresh from its live-change rows alone. */
function rebuilt(store: Store) {
  const fresh = beforeKeys(store.list(LIVE_CHANGE));
  liveNear(
    fresh.store,
    OUTSIDER,
    decodeIntent({ revision: 1, goal: "read", footprint: [], premises: [] }),
  );
  return keyRowsOf(fresh.store);
}

const onOneLine = (a: readonly string[], b: readonly string[]): boolean => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((segment, i) => segment === long[i]);
};

/**
 * The near read's promise, written apart from its keys: a live change is read
 * for an intent when one of its subjects sits at or under the parent of one of
 * mine (under mine, for a top-level one) or is an ancestor of one of mine, a
 * footprint prefix of each sits on one line, they share an anchor path, or
 * they are alternatives.
 */
function readFor(intent: Intent, live: LiveChange): boolean {
  const mine = intentPropositions(intent);
  const theirs = livePropositions(live);
  const bySubject = mine.some(({ subject: m }) =>
    theirs.some(
      ({ subject: t }) =>
        isAncestorOrSelf(parentSubject(m) ?? m, t) || subjectAncestors(m).includes(t),
    ),
  );
  const byFootprint = intent.footprint.some((g) =>
    live.intent.footprint.some((h) => onOneLine(literalPrefix(g.path), literalPrefix(h.path))),
  );
  const theirAnchors = anchorPathsOf(theirs);
  const byAnchor = [...anchorPathsOf(mine)].some((path) => theirAnchors.has(path));
  return bySubject || byFootprint || byAnchor || areAlternatives(intent, live.intent);
}

/** How often the reads met what makes order and every reason matter, so the property is not vacuous. */
const reached = { neighbours: 0, contradictions: 0, alternatives: 0 };

/**
 * For each live change at its own intent, each probe as a change the index
 * never heard of, and each probe as the first live change revised to it:
 * exposure over the near read is exposure over every live change, and the
 * read holds exactly the changes its promise names, counted.
 */
function nearIsAll(store: Store, probes: readonly Intent[]) {
  const all = liveChanges(store);
  const asked: (readonly [ChangeId, Intent])[] = [
    ...all.map((live) => [live.id, live.intent] as const),
    ...probes.map((probe) => [OUTSIDER, probe] as const),
    ...(all[0] === undefined
      ? []
      : probes.map((probe) => [all[0]?.id ?? OUTSIDER, probe] as const)),
  ];
  for (const [self, intent] of asked) {
    const near = liveNear(store, self, intent);
    const found = exposure(self, intent, all);
    expect(exposure(self, intent, near.changes)).toEqual(found);
    if (found.neighbours.length > 1) reached.neighbours++;
    if (found.contradictions.length > 1) reached.contradictions++;
    if (found.alternatives.length > 1) reached.alternatives++;
    expect(near.changes.map((live) => live.id)).toEqual(
      all.filter((live) => live.id !== self && readFor(intent, live)).map((live) => live.id),
    );
    expect(near.compared.changes).toBe(near.changes.length);
  }
}

describe("[t694.near-equals-all] a preflight's near read finds what reading every live change finds", () => {
  it(
    "[t694.near-equals-all] over any live set, revised and derived for, then partly and wholly ended: exposure over the near read is exposure over all, the read is exactly its promise, and the key rows are the live changes' own",
    () => {
      fc.assert(
        fc.property(worldArb, (world) => {
          const probes = world.probes.map((probe) => decodeIntent({ revision: 1, ...probe }));
          const live = index();
          fold(world, live);
          nearIsAll(live.store, probes);
          expect(keyRowsOf(live.store)).toEqual(rebuilt(live.store));

          world.plans.forEach((plan, i) => {
            if (plan.end !== undefined) live.hear(ended(changeOf(i), plan.end));
          });
          nearIsAll(live.store, probes);
          expect(keyRowsOf(live.store)).toEqual(rebuilt(live.store));

          world.plans.forEach((_, i) => live.hear(ended(changeOf(i), "ChangeWithdrawn")));
          expect(keyRowsOf(live.store)).toEqual([[], [], [], []]);
          expect(live.store.list(ALT_SHOWN)).toEqual([]);
        }),
      );
      expect(Object.values(reached).every((times) => times > 0)).toBe(true);
    },
    PROPERTY_TIMEOUT,
  );
});

describe("[t694.backfill] an index from before the key rows answers as one the fold built", () => {
  it(
    "[t694.backfill] a store holding only live-change rows reads near as the folded one does, and builds every key row on its first read or its first event",
    () => {
      fc.assert(
        fc.property(worldArb, (world) => {
          const probes = world.probes.map((probe) => decodeIntent({ revision: 1, ...probe }));
          const folded = index();
          fold(world, folded);
          const rows = folded.store.list(LIVE_CHANGE);

          const read = beforeKeys(rows);
          expect(keyRowsOf(read.store)).toEqual([[], [], [], []]);
          const all = liveChanges(folded.store);
          for (const [self, intent] of [
            ...all.map((change) => [change.id, change.intent] as const),
            ...probes.map((probe) => [OUTSIDER, probe] as const),
          ])
            expect(liveNear(read.store, self, intent)).toEqual(
              liveNear(folded.store, self, intent),
            );
          expect(keyRowsOf(read.store)).toEqual(keyRowsOf(folded.store));

          const [first] = all;
          if (first === undefined) return;
          const heard = beforeKeys(rows);
          const end = ended(first.id, "ChangeWithdrawn");
          heard.hear(end);
          folded.hear(end);
          expect(keyRowsOf(heard.store)).toEqual(keyRowsOf(folded.store));
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );
});

/** A notice the index commits, as who it tells and about which change. */
type Told = readonly [kind: "declared" | "landed", to: string, about: string];

const toldOf = (draft: EventDraft): Told => {
  if (draft.payload._tag === "AlternativeLanded") {
    const landed = Schema.decodeUnknownSync(AlternativeLanded)(draft.payload);
    return ["landed", landed.changeId, landed.landedChangeId];
  }
  const shown = Schema.decodeUnknownSync(AlternativeDeclared)(draft.payload);
  return ["declared", shown.changeId, shown.alternativeId];
};

/**
 * The index's alternatives as they were before the key rows, by a scan of
 * every live change and every pair: who is live with which intent, who has
 * been shown whom, and the notices each event gives.
 */
function wholeScan() {
  const live = new Map<string, Intent>();
  const shown = new Set<string>();
  const alternativesTo = (self: string, intent: Intent) =>
    [...live]
      .filter(([id, other]) => id !== self && areAlternatives(intent, other))
      .map(([id]) => id)
      .toSorted();
  const forget = (id: string) => {
    live.delete(id);
    for (const pair of shown) if (pair.split("/").includes(id)) shown.delete(pair);
  };
  return {
    shown,
    declare: (id: string, intent: Intent): readonly Told[] => {
      live.set(id, intent);
      return [];
    },
    revise: (id: string, revised: typeof IntentRevised.Type): readonly Told[] => {
      const held = live.get(id);
      if (held !== undefined) live.set(id, reviseIntent(held, revised));
      return [];
    },
    preflight: (id: string, listed: readonly string[]): readonly Told[] => {
      const intent = live.get(id);
      if (intent === undefined) return [];
      const alternatives = alternativesTo(id, intent);
      for (const other of listed) shown.add(`${id}/${other}`);
      for (const pair of shown) {
        const [a, b] = pair.split("/");
        const other = a === id ? b : b === id ? a : undefined;
        if (other !== undefined && !alternatives.includes(other)) shown.delete(pair);
      }
      const told: Told[] = [];
      const tell = (target: string, about: string) => {
        if (shown.has(`${target}/${about}`)) return;
        shown.add(`${target}/${about}`);
        told.push(["declared", target, about]);
      };
      for (const other of alternatives) {
        tell(other, id);
        tell(id, other);
      }
      return told;
    },
    end: (id: string, landed: boolean): readonly Told[] => {
      const intent = live.get(id);
      const told: Told[] =
        landed && intent !== undefined
          ? alternativesTo(id, intent).map((other) => ["landed", other, id] as const)
          : [];
      forget(id);
      return told;
    },
  };
}

/** Notices in the order of who they tell. */
const byTarget = (a: Told, b: Told) => a[1].localeCompare(b[1]);

/** An intent whose declared effects make `claims`, in the order given. */
const claimingIntent = (claims: readonly Json[]) => ({
  goal: "attempt",
  footprint: [],
  premises: [],
  declaredEffects: claims,
});

describe("[t694.claim] alternatives by claim key", () => {
  it(
    "[t694.claim] any declares, revisions, preflights and ends: the notices and the pairs shown are those the scan of every live change gave",
    () => {
      let told = 0;
      const op = fc.oneof(
        fc.record({ op: fc.constant("declare" as const), i: fc.nat(4), claims: claimSetArb }),
        fc.record({ op: fc.constant("revise" as const), i: fc.nat(4), claims: claimSetArb }),
        fc.record({
          op: fc.constant("preflight" as const),
          i: fc.nat(4),
          listed: fc.subarray([0, 1, 2, 3, 4]),
        }),
        fc.record({ op: fc.constant("preflight" as const), i: fc.nat(4), listed: fc.constant([]) }),
        fc.record({ op: fc.constant("end" as const), i: fc.nat(4), landed: fc.boolean() }),
      );
      // Every run opens with two changes declaring the same claims, one of them preflighted, so every run tells
      // someone: alternatives meet seldom by chance (a few runs in 300), and a run that tells nobody compares no
      // notices. What follows is drawn freely.
      const opening = fc
        .tuple(
          fc.nat(4),
          fc.nat(3),
          claimSetArb.filter((claims) => claims.length > 0),
        )
        .map(([first, step, claims]) => [
          { op: "declare" as const, i: first, claims },
          { op: "declare" as const, i: (first + 1 + step) % 5, claims },
          { op: "preflight" as const, i: first, listed: [] },
        ]);
      fc.assert(
        fc.property(opening, fc.array(op, { maxLength: 30 }), (opened, drawn) => {
          const ops = [...opened, ...drawn];
          const folded = index();
          const scan = wholeScan();
          for (const o of ops) {
            const changeId = changeOf(o.i);
            let heard: readonly Told[];
            let expected: readonly Told[];
            if (o.op === "declare") {
              const intent = {
                goal: "attempt",
                footprint: [],
                premises: [],
                declaredEffects: o.claims,
              };
              heard = folded.hear(declared(o.i, intent)).map(toldOf);
              expected = scan.declare(changeId, decodeIntent({ revision: 1, ...intent }));
            } else if (o.op === "revise") {
              const payload = {
                _tag: "IntentRevised",
                changeId,
                revision: 2,
                premisesAdded: [],
                premisesRetracted: [],
                declaredEffects: o.claims,
              };
              heard = folded.hear(eventOf(changeId, payload)).map(toldOf);
              expected = scan.revise(changeId, Schema.decodeUnknownSync(IntentRevised)(payload));
            } else if (o.op === "preflight") {
              const listed = o.listed.filter((j) => j !== o.i).map(changeOf);
              heard = folded
                .hear(
                  eventOf(changeId, {
                    _tag: "PreflightIssued",
                    changeId,
                    revision: 1,
                    neighbours: [],
                    contradictions: [],
                    precedents: [],
                    suggestedMove: "proceed",
                    ...(listed.length === 0 ? {} : { alternatives: listed }),
                  }),
                )
                .map(toldOf);
              expected = scan.preflight(changeId, listed);
            } else {
              const type = o.landed ? "ChangeLanded" : "ChangeWithdrawn";
              heard = folded.hear(ended(changeId, type)).map(toldOf);
              expected = scan.end(changeId, o.landed);
            }
            told += heard.length;
            expect(heard).toEqual(expected);
            expect(folded.store.list(ALT_SHOWN).map((row) => row.id)).toEqual(
              [...scan.shown].toSorted(),
            );
          }
        }),
      );
      expect(told).toBeGreaterThan(0);
    },
    PROPERTY_TIMEOUT,
  );

  it("[t694.claim] two intents making the same claims in another order are found as alternatives by key", () => {
    const folded = index();
    const [first, second] = POOL;
    if (first === undefined || second === undefined) throw new Error("POOL holds two claims");
    folded.hear(declared(0, claimingIntent([first, second])));
    folded.hear(declared(1, claimingIntent([second, first])));
    const heard = folded
      .hear(
        eventOf(changeOf(1), {
          _tag: "PreflightIssued",
          changeId: changeOf(1),
          revision: 1,
          neighbours: [],
          contradictions: [],
          precedents: [],
          suggestedMove: "proceed",
        }),
      )
      .map(toldOf);
    const expected: Told[] = [
      ["declared", changeOf(0), changeOf(1)],
      ["declared", changeOf(1), changeOf(0)],
    ];
    expect(heard.toSorted(byTarget)).toEqual(expected.toSorted(byTarget));
  });
});

describe("[live-index.proposal-moved] a proposal moved to another commit", () => {
  it("[live-index.proposal-moved] is found near by the footprint of the commit it carries now, and no longer by the one it left", () => {
    const at = index();
    const moved = changeOf(0);
    at.hear(
      declared(0, {
        goal: "Retry the fetch",
        footprint: [{ path: "docs/retry.md", op: "create" }],
        premises: [],
      }),
    );
    at.hear(
      eventOf(moved, {
        _tag: "ProposalUpdated",
        changeId: moved,
        commit: "a".repeat(40),
        footprint: [
          { path: "src/retry.ts", op: "create" },
          { path: "src/fetch.ts", op: "edit" },
        ],
      }),
    );
    const nearTo = (path: string) =>
      liveNear(
        at.store,
        OUTSIDER,
        decodeIntent({
          revision: 1,
          goal: "read",
          footprint: [{ path, op: "edit" }],
          premises: [],
        }),
      ).changes.map((live) => live.id);
    expect(nearTo("src/fetch.ts")).toEqual([moved]);
    expect(nearTo("docs/retry.md")).toEqual([]);
  });
});
