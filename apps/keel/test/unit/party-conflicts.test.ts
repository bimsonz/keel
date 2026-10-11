import { describe, expect, it } from "vitest";
import {
  blockersOf,
  hearConflict,
  keepPlanPolicy,
  planPolicyOf,
} from "@keeltown/core/application/coordination";
import type { PredicatePolicies } from "@keeltown/core/domain/coordination";
import { type ChangeId, EventEnvelope, makeId } from "@keeltown/core/kernel";
import { makeEntityStoreMemory } from "@keeltown/testing";
import { Schema } from "effect";
import * as fc from "fast-check";

// prove:red pins the seed with FC_SEED; a plain run explores a fresh one.
const seed = process.env["FC_SEED"];
fc.configureGlobal({ numRuns: 200, ...(seed === undefined ? {} : { seed: Number(seed) }) });

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let made = 0;
/** Distinct ids without randomness, so a seeded run replays exactly. */
const nextId = <P extends "chg" | "cfl" | "evt">(prefix: P) => {
  made += 1;
  let n = made;
  let body = "";
  for (let i = 0; i < 26; i += 1) {
    body = (CROCKFORD[n % 32] ?? "0") + body;
    n = Math.floor(n / 32);
  }
  return makeId(prefix, body);
};

const PREDICATES = ["freshness", "ordering", "cardinality"] as const;
const POLICIES = ["block", "advise", "annotate"] as const;
/** What a party hears of one conflict after it opens, in order. */
const ENDINGS = [
  [],
  ["ConflictProven"],
  ["ConflictProven", "ConflictResolved"],
  ["ConflictDismissed"],
  ["ConflictEscalated"],
  ["ConflictEscalated", "ConflictResolved"],
] as const;
type Life = {
  readonly predicate: (typeof PREDICATES)[number] | undefined;
  readonly ending: (typeof ENDINGS)[number];
};

const envelope = (type: string, payload: object) =>
  Schema.decodeUnknownSync(EventEnvelope)({
    eventId: nextId("evt"),
    type,
    entity: { kind: "conflict", id: "cfl_0" },
    seq: 1,
    at: 0,
    dedupeKey: `${type}#${made}`,
    affected: [],
    notified: [],
    payload: { _tag: type, ...payload },
  });

const MOVE_PAYLOAD: Record<string, object> = {
  ConflictProven: { evidence: { _tag: "probe", probeId: "prb_00000000000000000000000000" } },
  ConflictDismissed: { evidence: "probe:prb_0:non-discriminating" },
  ConflictEscalated: { escalationId: "esc_00000000000000000000000000", reason: "unprovable" },
  ConflictResolved: { move: "refine" },
};

/** Each conflict's events as its party hears them: opened, then its ending, interleaved across conflicts in any order. */
function heard(change: ChangeId, lives: readonly Life[], order: readonly number[]) {
  const queues = lives.map((life) => {
    const conflictId = nextId("cfl");
    return {
      conflictId,
      events: [
        envelope("ConflictSuspected", {
          conflictId,
          kind: "semantic",
          parties: [change, nextId("chg")],
          ...(life.predicate === undefined ? {} : { predicate: life.predicate }),
        }),
        ...life.ending.map((type) => envelope(type, { conflictId, ...MOVE_PAYLOAD[type] })),
      ],
    };
  });
  const out: EventEnvelope[] = [];
  let i = 0;
  for (;;) {
    const pending = queues.filter((queue) => queue.events.length > 0);
    if (pending.length === 0) return { queues, events: out };
    const queue = pending[(order[i] ?? 0) % pending.length];
    const next = queue?.events.shift();
    if (next !== undefined) out.push(next);
    i += 1;
  }
}

const policiesArb: fc.Arbitrary<PredicatePolicies | undefined> = fc.option(
  fc.record(
    {
      freshness: fc.constantFrom(...POLICIES),
      ordering: fc.constantFrom(...POLICIES),
      cardinality: fc.constantFrom(...POLICIES),
    },
    { requiredKeys: [] },
  ),
  { nil: undefined },
);

describe("the conflicts a change is a party to", () => {
  it("[b21.proven-blocks] blocks the change on exactly the conflicts proven against it, unresolved, whose predicate's policy is block (absent is advise)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            predicate: fc.option(fc.constantFrom(...PREDICATES), { nil: undefined }),
            ending: fc.constantFrom(...ENDINGS),
          }),
          { maxLength: 8 },
        ),
        fc.array(fc.nat(), { maxLength: 30 }),
        policiesArb,
        (lives, order, policies) => {
          const store = makeEntityStoreMemory().service;
          const change = nextId("chg");
          const { queues, events } = heard(change, lives, order);
          for (const event of events) expect(hearConflict(store, event)).toBe(true);

          const expected = lives.flatMap((life, i) => {
            const policy =
              (life.predicate === undefined ? undefined : policies?.[life.predicate]) ?? "advise";
            const proven = life.ending.at(-1) === "ConflictProven";
            const conflictId = queues[i]?.conflictId;
            return proven && policy === "block" && conflictId !== undefined ? [conflictId] : [];
          });
          expect([...blockersOf(store, policies).openProvenConflicts].toSorted()).toEqual(
            expected.toSorted(),
          );
        },
      ),
    );
  });

  it("[b21.policy-default] a plan with no policy, or one silent on the predicate, only advises; the plan's own policy is kept until the next plan replaces it", () => {
    const store = makeEntityStoreMemory().service;
    const change = nextId("chg");
    const conflictId = nextId("cfl");
    hearConflict(
      store,
      envelope("ConflictSuspected", {
        conflictId,
        kind: "semantic",
        parties: [change],
        predicate: "freshness",
      }),
    );
    hearConflict(
      store,
      envelope("ConflictProven", { conflictId, ...MOVE_PAYLOAD["ConflictProven"] }),
    );

    expect(blockersOf(store, undefined).openProvenConflicts).toEqual([]);
    expect(blockersOf(store, { ordering: "block" }).openProvenConflicts).toEqual([]);
    expect(blockersOf(store, { freshness: "block" }).openProvenConflicts).toEqual([conflictId]);

    keepPlanPolicy(store, change, { freshness: "block" });
    expect(planPolicyOf(store, change)).toEqual({ freshness: "block" });
    keepPlanPolicy(store, change, undefined);
    expect(planPolicyOf(store, change)).toBeUndefined();
  });

  it("[b21.party-hears] ignores events that are not a conflict's moves", () => {
    const store = makeEntityStoreMemory().service;
    expect(hearConflict(store, envelope("WorldCheckRan", { conflictId: nextId("cfl") }))).toBe(
      false,
    );
    expect(store.list("party-conflict")).toEqual([]);
  });
});
