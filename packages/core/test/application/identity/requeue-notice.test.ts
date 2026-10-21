// A change sent back to the front of its lane's queue: its agent's notice says
// from which batch and why, in words of its own for each reason, and what Keel
// does with the change next. A queued change takes no rebase or submit, so the
// notice asks for neither; after a clash it runs alone, as the lane runs it.
import { describe, expect, it } from "vitest";
import {
  actionsOf,
  detailOf,
  entriesAfter,
  recordDelivery,
} from "../../../src/application/identity/index.ts";
import type { EntityStore, Stored } from "../../../src/application/ports/index.ts";
import { RequeueReason } from "../../../src/domain/coordination/index.ts";
import { runsAlone } from "../../../src/domain/integration/index.ts";
import { type EventEnvelope, Instant, makeId } from "../../../src/domain/kernel/index.ts";

const ulid = (n: number): string => String(n).padStart(26, "0");
const CHANGE = makeId("chg", ulid(3));
const BATCH = makeId("bat", ulid(5));
const REASONS = RequeueReason.literals;

/** A requeue as the Change DO commits it; `planned: false` as it was committed before the plan was kept on it. */
const requeued = (reason: string, planned = true): EventEnvelope => ({
  eventId: makeId("evt", ulid(4)),
  type: "ChangeRequeued",
  entity: { kind: "change", id: CHANGE },
  seq: 11,
  at: Instant(1_760_000_000_000),
  dedupeKey: `change:${CHANGE}/requeue#1`,
  affected: [],
  notified: [],
  payload: {
    _tag: "ChangeRequeued",
    changeId: CHANGE,
    batchId: BATCH,
    reason,
    ...(planned ? { planHash: `sha256:${"0".repeat(64)}` } : {}),
  },
});

/** A word each reason's own account of the requeue holds, and no other's. */
const WORD: Record<RequeueReason, RegExp> = {
  "infra-failure": /infrastructure/,
  bisection: /splitting/,
  invalidated: /trunk moved/,
  "co-member-failed": /another change/,
  textual: /merged/,
  interaction: /passed apart/,
  shrink: /fewer tests/,
};

type Store = (typeof EntityStore)["Service"];

/** An entity store in memory: rows by kind, then id, listed in id order. */
const memoryStore = (): Store => {
  const kinds = new Map<string, Map<string, Stored>>();
  const rows = (kind: string): Map<string, Stored> => {
    const found = kinds.get(kind);
    if (found !== undefined) return found;
    const made = new Map<string, Stored>();
    kinds.set(kind, made);
    return made;
  };
  return {
    get: (kind, id) => rows(kind).get(id),
    put: (kind, id, value) => {
      rows(kind).set(id, value);
    },
    remove: (kind, id) => {
      rows(kind).delete(id);
    },
    list: (kind, idPrefix = "") =>
      [...rows(kind)]
        .filter(([id]) => id.startsWith(idPrefix))
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, value]) => ({ id, value })),
    transaction: (body) => body(),
  };
};

describe("a change requeued, told to its agent", () => {
  it("[requeue-notice.every-reason] says for every reason that the change was requeued, from which batch, and why in that reason's own words", () => {
    const details = REASONS.map((reason) => detailOf(requeued(reason)) ?? "");

    expect(details.map((detail) => detail.startsWith(`Requeued from ${BATCH}: `))).toEqual(
      REASONS.map(() => true),
    );
    expect(
      REASONS.map((reason) => details.filter((detail) => WORD[reason].test(detail)).length),
    ).toEqual(REASONS.map(() => 1));
    expect(REASONS.map((reason, i) => WORD[reason].test(details[i] ?? ""))).toEqual(
      REASONS.map(() => true),
    );
  });

  it("[requeue-notice.actions] asks the agent to wait for what Keel does next, then where to read the change, and for no call a queued change refuses", () => {
    const actions = REASONS.map((reason) => actionsOf(requeued(reason)));
    const next = REASONS.map((reason) => (detailOf(requeued(reason)) ?? "").split(". ").at(-1));

    expect(actions).toEqual(
      REASONS.map((_, i) => [
        { kind: "wait", title: next[i]?.replace(/\.$/, "") },
        {
          kind: "read",
          title: "Read where the change stands",
          operationId: "status",
          args: { changeId: CHANGE, wait: 30 },
        },
      ]),
    );
  });

  it("[requeue-notice.alone] says the change runs alone next exactly where the lane runs it alone", () => {
    expect(REASONS.map((reason) => /\balone\b/.test(detailOf(requeued(reason)) ?? ""))).toEqual(
      REASONS.map(runsAlone),
    );
  });

  it("[requeue-notice.old-log] tells a requeue committed before the plan was kept on it the same, and one it cannot read not at all", () => {
    expect(
      REASONS.map((reason) => [
        detailOf(requeued(reason, false)),
        actionsOf(requeued(reason, false)),
      ]),
    ).toEqual(REASONS.map((reason) => [detailOf(requeued(reason)), actionsOf(requeued(reason))]));
    expect(REASONS.map((reason) => detailOf(requeued(reason, false)) === undefined)).toEqual(
      REASONS.map(() => false),
    );
    expect([detailOf(requeued("rebased")), actionsOf(requeued("rebased"))]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("[requeue-notice.stored] keeps the notice's words and next actions as the inbox reads them back", () => {
    const store = memoryStore();
    recordDelivery(store, requeued("textual"));
    const [read] = entriesAfter(store, undefined);

    expect(read?.entry.type).toBe("ChangeRequeued");
    expect(read?.entry.detail).toMatch(
      new RegExp(
        `^Requeued from ${BATCH}: the changes in its batch could not be merged together\\. Runs alone next`,
      ),
    );
    expect(read?.entry.nextActions?.map((action) => [action.kind, action.operationId])).toEqual([
      ["wait", undefined],
      ["read", "status"],
    ]);
  });
});
