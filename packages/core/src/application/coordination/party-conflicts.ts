import { Option, Schema } from "effect";
import {
  type Blockers,
  Predicate,
  type PredicatePolicies,
} from "../../domain/coordination/index.ts";
import {
  ChangeId,
  ConflictId,
  DEFAULT_PREDICATE_POLICY,
  type EntityRef,
  type EscalationId,
  type EventEnvelope,
  type PredicatePolicy,
  SubjectId,
} from "../../domain/kernel/index.ts";
import { Party } from "../../domain/verification/index.ts";
import type { Transaction } from "../ports/commit.ts";
import type { Stored } from "../ports/entity-store.ts";
import { consequenceOf, escalationIdOf } from "./escalations.ts";

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

const PartyConflict = Schema.Struct({
  conflictId: ConflictId,
  subjectId: Schema.optional(SubjectId),
  predicate: Schema.optional(Predicate),
  /** The change relying on the premise at stake, and the change making the effect against it: the two a ruling is between. */
  holder: Schema.optional(ChangeId),
  author: Schema.optional(ChangeId),
  /** Every change among its parties; absent on a row kept before they were, which falls back to holder and author. */
  parties: Schema.optional(Schema.Array(ChangeId)),
  state: Schema.Literals(["open", "proven", "dismissed", "escalated", "resolved"]),
});
export type PartyConflict = typeof PartyConflict.Type;

const decodeRow = Schema.decodeUnknownSync(PartyConflict);
const encodeRow = Schema.encodeSync(PartyConflict);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

const Suspected = Schema.Struct({
  conflictId: ConflictId,
  parties: Schema.Array(Party),
  subjectId: Schema.optional(SubjectId),
  predicate: Schema.optional(Predicate),
  premise: Schema.optional(Schema.Struct({ holder: ChangeId })),
  effect: Schema.optional(Schema.Struct({ changeId: ChangeId })),
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
 * with its subject, its predicate and its two sides, and each later move sets
 * its state. A move
 * for a conflict never heard opening is kept without a predicate, so it
 * resolves to the default policy. Returns whether the event was a conflict's.
 */
export function hearConflict(store: Store, event: EventEnvelope): boolean {
  if (event.type === "ConflictSuspected") {
    const suspected = decodeSuspected(event.payload);
    if (Option.isNone(suspected)) return false;
    const { conflictId, subjectId, predicate, premise, effect, parties } = suspected.value;
    if (store.get(PARTY_CONFLICT, conflictId) !== undefined) return true;
    store.put(
      PARTY_CONFLICT,
      conflictId,
      asStored(
        encodeRow({
          conflictId,
          ...(subjectId === undefined ? {} : { subjectId }),
          ...(predicate === undefined ? {} : { predicate }),
          ...(premise === undefined ? {} : { holder: premise.holder }),
          ...(effect === undefined ? {} : { author: effect.changeId }),
          parties: changeParties(parties),
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

/** The conflict the change is a party to, as it has heard it; undefined for one never heard. */
export function partyConflictOf(store: Store, conflictId: ConflictId): PartyConflict | undefined {
  const stored = store.get(PARTY_CONFLICT, conflictId);
  return stored === undefined ? undefined : decodeRow(stored);
}

/**
 * What a ruling against `changeId` on a conflict means for it, in the words
 * of the option the ruling chose: against the change making the effect the
 * premise stood, and against the premise's holder the effect stood. Undefined
 * for a conflict the change heard without its two sides, or is on neither of.
 */
export function consequenceAgainst(
  store: Store,
  conflictId: ConflictId,
  changeId: ChangeId,
): string | undefined {
  const { holder, author } = partyConflictOf(store, conflictId) ?? {};
  if (holder === undefined || author === undefined || holder === author) return undefined;
  if (changeId !== holder && changeId !== author) return undefined;
  return consequenceOf(changeId === author ? "premise" : "effect", { holder, other: author });
}

/**
 * What blocks the change from queueing or batching: each conflict proven
 * against it whose predicate's policy is `block`, and not since resolved.
 * Guards and drift do not block yet. `awaitingRuling` holds it out of a batch
 * only: the escalation of each of its conflicts that is with a person.
 */
export const blockersOf = (store: Store, policies: PredicatePolicies | undefined): Blockers => ({
  openProvenConflicts: store
    .list(PARTY_CONFLICT)
    .map((row) => decodeRow(row.value))
    .filter((row) => row.state === "proven" && policyFor(policies, row.predicate) === "block")
    .map((row) => row.conflictId),
  failingGuards: [],
  unresolvedHighDrift: [],
  awaitingRuling: awaitedEscalations(store),
});

/** The states in which a conflict is not settled: suspected or probing (`open`), proven, or with a person. */
const UNSETTLED: ReadonlySet<PartyConflict["state"]> = new Set(["open", "proven", "escalated"]);

/**
 * The other changes `self` shares a conflict with that is not yet settled
 * (neither dismissed nor resolved), from the rows its own DO keeps: the Lane
 * never puts two of them in one batch. Sorted, each once.
 */
export function unsettledWith(store: Store, self: ChangeId): readonly ChangeId[] {
  const others = store
    .list(PARTY_CONFLICT)
    .map((row) => decodeRow(row.value))
    .filter((row) => UNSETTLED.has(row.state))
    .flatMap((row) => row.parties ?? [row.holder, row.author].filter(isChange))
    .filter((id) => id !== self);
  return [...new Set(others)].toSorted();
}

/** The escalations the change's conflicts wait on: each conflict with a person and not yet ruled on, by conflict id. */
export function awaitedEscalations(store: Store): readonly EscalationId[] {
  return store
    .list(PARTY_CONFLICT)
    .map((row) => decodeRow(row.value))
    .filter((row) => row.state === "escalated")
    .map((row) => row.conflictId)
    .toSorted()
    .map(escalationIdOf);
}

/**
 * The escalation the change must wait for: that of a conflict it is a party
 * to which is with a person and not yet ruled on. The first by conflict id
 * when there are several: the change waits for one ruling at a time.
 */
export function awaitedEscalation(store: Store): EscalationId | undefined {
  return awaitedEscalations(store)[0];
}
