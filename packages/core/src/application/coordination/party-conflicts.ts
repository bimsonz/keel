import { Option, Schema } from "effect";
import { type Blockers, Predicate, PredicatePolicies } from "../../domain/coordination/index.ts";
import {
  ChangeId,
  ConflictId,
  DEFAULT_PREDICATE_POLICY,
  type EntityRef,
  type EventEnvelope,
  type PredicatePolicy,
  SubjectId,
} from "../../domain/kernel/index.ts";
import { Party } from "../../domain/verification/index.ts";
import type { Transaction } from "../ports/commit.ts";
import type { Stored } from "../ports/entity-store.ts";

type Store = Transaction["store"];
type Outbox = Transaction["outbox"];

/** What a change hears of the conflicts it is a party to, scoped to it on the conflict's Subject DO. */
export const PARTY_HEARS = [
  "ConflictSuspected",
  "ConflictProven",
  "ConflictDismissed",
  "ConflictEscalated",
  "ConflictResolved",
] as const;

/** Where a Change DO keeps each conflict it is a party to, by conflict id. */
export const PARTY_CONFLICT = "party-conflict";
/** Where a Change DO keeps its compiled plan's predicate policy, by change id. */
export const PLAN_POLICY = "plan-policy";

const PartyConflict = Schema.Struct({
  conflictId: ConflictId,
  subjectId: Schema.optional(SubjectId),
  predicate: Schema.optional(Predicate),
  state: Schema.Literals(["open", "proven", "dismissed", "escalated", "resolved"]),
});
type PartyConflict = typeof PartyConflict.Type;

const decodeRow = Schema.decodeUnknownSync(PartyConflict);
const encodeRow = Schema.encodeSync(PartyConflict);
const decodePolicies = Schema.decodeUnknownSync(PredicatePolicies);
const encodePolicies = Schema.encodeSync(PredicatePolicies);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

const Suspected = Schema.Struct({
  conflictId: ConflictId,
  parties: Schema.Array(Party),
  subjectId: Schema.optional(SubjectId),
  predicate: Schema.optional(Predicate),
});
const Moved = Schema.Struct({ conflictId: ConflictId });
const decodeSuspected = Schema.decodeUnknownOption(Suspected);
const decodeMoved = Schema.decodeUnknownOption(Moved);
const isChange = Schema.is(ChangeId);

const STATE_AFTER: Partial<Record<string, PartyConflict["state"]>> = {
  ConflictProven: "proven",
  ConflictDismissed: "dismissed",
  ConflictEscalated: "escalated",
  ConflictResolved: "resolved",
};

/** The changes among a conflict's parties: a tenet is a party too, but has no Change DO to tell. */
export const changeParties = (parties: readonly Party[]): readonly ChangeId[] =>
  parties.filter(isChange);

/**
 * Opens a conflict to its changes: each party's Change DO is owed the
 * conflict's moves, scoped to it, so the conflict's events must name the
 * parties as `affected` (`affectingParties`).
 */
export function subscribeParties(outbox: Outbox, parties: readonly Party[]): void {
  for (const changeId of changeParties(parties))
    outbox.subscribe(`change:${changeId}`, PARTY_HEARS, { kind: "change", id: changeId });
}

/** The entities a conflict's event affects: its changes, so each party's scoped subscription hears it. */
export const affectingParties = (parties: readonly Party[]): readonly EntityRef[] =>
  changeParties(parties).map((id) => ({ kind: "change", id }));

/**
 * A Change DO records a conflict it is a party to: ConflictSuspected opens it
 * with its subject and predicate, and each later move sets its state. A move
 * for a conflict never heard opening is kept without a predicate, so it
 * resolves to the default policy. Returns whether the event was a conflict's.
 */
export function hearConflict(store: Store, event: EventEnvelope): boolean {
  if (event.type === "ConflictSuspected") {
    const suspected = decodeSuspected(event.payload);
    if (Option.isNone(suspected)) return false;
    const { conflictId, subjectId, predicate } = suspected.value;
    if (store.get(PARTY_CONFLICT, conflictId) !== undefined) return true;
    store.put(
      PARTY_CONFLICT,
      conflictId,
      asStored(
        encodeRow({
          conflictId,
          ...(subjectId === undefined ? {} : { subjectId }),
          ...(predicate === undefined ? {} : { predicate }),
          state: "open",
        }),
      ),
    );
    return true;
  }
  const state = STATE_AFTER[event.type];
  if (state === undefined) return false;
  const moved = decodeMoved(event.payload);
  if (Option.isNone(moved)) return false;
  const known = store.get(PARTY_CONFLICT, moved.value.conflictId);
  const row: PartyConflict =
    known === undefined
      ? { conflictId: moved.value.conflictId, state }
      : { ...decodeRow(known), state };
  store.put(PARTY_CONFLICT, row.conflictId, asStored(encodeRow(row)));
  return true;
}

/** The policy a change applies to a proven conflict on `predicate`: the plan's, or `advise` when the plan or the predicate is silent. */
export const policyFor = (
  policies: PredicatePolicies | undefined,
  predicate: Predicate | undefined,
): PredicatePolicy =>
  (predicate === undefined ? undefined : policies?.[predicate]) ?? DEFAULT_PREDICATE_POLICY;

/** Keeps the compiled plan's predicate policy; a plan without one clears the last plan's. */
export function keepPlanPolicy(
  store: Store,
  changeId: ChangeId,
  policies: PredicatePolicies | undefined,
): void {
  if (policies === undefined) store.remove(PLAN_POLICY, changeId);
  else store.put(PLAN_POLICY, changeId, asStored(encodePolicies(policies)));
}

/** The change's compiled plan's predicate policy, if its plan had one. */
export function planPolicyOf(store: Store, changeId: ChangeId): PredicatePolicies | undefined {
  const stored = store.get(PLAN_POLICY, changeId);
  return stored === undefined ? undefined : decodePolicies(stored);
}

/**
 * What blocks the change from queueing or batching: each conflict proven
 * against it whose predicate's policy is `block`, and not since resolved.
 * Guards and drift do not block yet.
 */
export const blockersOf = (store: Store, policies: PredicatePolicies | undefined): Blockers => ({
  openProvenConflicts: store
    .list(PARTY_CONFLICT)
    .map((row) => decodeRow(row.value))
    .filter((row) => row.state === "proven" && policyFor(policies, row.predicate) === "block")
    .map((row) => row.conflictId),
  failingGuards: [],
  unresolvedHighDrift: [],
});
