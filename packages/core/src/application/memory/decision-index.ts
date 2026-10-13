import { Effect, Option, Schema } from "effect";
import type { Proposition, SubjectKey } from "../../domain/coordination/index.ts";
import {
  ConflictId,
  type DecisionId,
  type EventEnvelope,
  type GuardId,
  ProjectId,
} from "../../domain/kernel/index.ts";
import {
  Decision,
  DecisionEvent,
  DecisionNotFound,
  evolveDecision,
} from "../../domain/memory/index.ts";
import { holds } from "../../domain/verification/index.ts";
import {
  ConflictFolded,
  type DecisionListPage,
  type DecisionListRead,
  EntityStore,
  type GuardDecision,
  type IndexedDecision,
  type Stored,
} from "../ports/index.ts";
import { CONFLICT_VIEWS } from "./conflict-views.ts";
import { labelGiven } from "./feed.ts";

/**
 * The Projector's index of decisions: each decision folded from its own
 * events by the domain's `evolveDecision`, with its project and the conflict
 * its ruling was about. What the ruling settled (the subject, whom it went
 * against, what it upheld, the guard that holds it) is the conflict's, and is
 * joined from the conflict view when the index is read: the ruling's events
 * and the conflict's come from different objects in no fixed order, so
 * whichever arrives first waits in its own row for the other.
 */
export const DECISION_INDEX = {
  /** The decision as its events leave it, with its project and conflict, by decision id. */
  decision: "decision-index",
  /** A project's decisions, by decision id, each with when it was decided: what its list reads. */
  project: (project: ProjectId) => `decision-list:${project}`,
  /** The decision recorded on a conflict, by conflict id. */
  conflict: (project: ProjectId) => `decision-conflict:${project}`,
} as const;

export const DECISION_PAGE = 50;
export const DECISION_PAGE_MAX = 100;

type Store = (typeof EntityStore)["Service"];

const DecisionRow = Schema.Struct({
  decision: Decision,
  project: ProjectId,
  conflictId: Schema.optional(ConflictId),
});
type DecisionRow = typeof DecisionRow.Type;

const decodeRow = Schema.decodeUnknownSync(DecisionRow);
const encodeRow = Schema.encodeSync(DecisionRow);
const decodeDecisionEvent = Schema.decodeUnknownOption(DecisionEvent);
const decodeConflictId = Schema.decodeUnknownOption(ConflictId);
const decodeFolded = Schema.decodeUnknownSync(ConflictFolded);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

const DECISION_TYPES: ReadonlySet<string> = new Set([
  "DecisionRecorded",
  "DecisionSuperseded",
  "DecisionOverruled",
]);

/** Whether the decision index folds this event at all. */
export const foldsDecision = (event: EventEnvelope): boolean => DECISION_TYPES.has(event.type);

function rowOf(store: Store, decisionId: string): DecisionRow | undefined {
  const stored = store.get(DECISION_INDEX.decision, decisionId);
  return stored === undefined ? undefined : decodeRow(stored);
}

/**
 * Folds one arrived event into the decision index, in the receipt's
 * transaction. The recording names the decision's project on its envelope and
 * the conflict it ruled among the entities it concerns. An event the index
 * cannot take (undecodable, out of the domain's order, of no project) leaves
 * it as it was and comes back as a problem for the caller to log.
 */
export function foldDecisionIndex(store: Store, event: EventEnvelope): string | undefined {
  const decoded = decodeDecisionEvent(event.payload);
  if (Option.isNone(decoded)) return `${event.eventId}: an undecodable ${event.type}`;
  const payload = decoded.value;
  const before = rowOf(store, payload.decisionId);
  let decision: Decision;
  try {
    decision = evolveDecision(before?.decision, { at: event.at, payload });
  } catch (thrown) {
    return `${event.eventId}: ${event.type} out of order for ${payload.decisionId} (${String(thrown)})`;
  }
  if (before !== undefined) {
    store.put(
      DECISION_INDEX.decision,
      payload.decisionId,
      asStored(encodeRow({ ...before, decision })),
    );
    return undefined;
  }
  const { project } = event;
  if (project === undefined) return `${payload.decisionId} was recorded with no project`;
  const conflictId = Option.getOrUndefined(
    decodeConflictId(event.affected.find((ref) => ref.kind === "conflict")?.id),
  );
  store.put(
    DECISION_INDEX.decision,
    payload.decisionId,
    asStored(encodeRow({ decision, project, ...(conflictId === undefined ? {} : { conflictId }) })),
  );
  store.put(DECISION_INDEX.project(project), payload.decisionId, decision.decidedAt);
  if (conflictId !== undefined)
    store.put(DECISION_INDEX.conflict(project), conflictId, payload.decisionId);
  return undefined;
}

const sameProposition = (a: Proposition, b: Proposition): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The decision with what its conflict says of it. Until the conflict's
 * resolution names this decision, the ruling has upheld nothing the index can
 * read. A guard holds the decision while it stands and asserts what the
 * ruling upheld: a guard is drawn from the premise, so a ruling for the effect
 * leaves its guard holding nothing.
 */
function joined(store: Store, row: DecisionRow): IndexedDecision {
  const stored =
    row.conflictId === undefined
      ? undefined
      : store.get(CONFLICT_VIEWS.conflict(row.project), row.conflictId);
  const folded = stored === undefined ? undefined : decodeFolded(stored);
  const conflict = folded?.conflict;
  const resolved = conflict?.decisionId === row.decision.id ? conflict : undefined;
  const upheld = resolved === undefined ? [] : holds(resolved, resolved.against ?? []);
  const asserted = conflict?.premise?.proposition;
  const guard = folded?.guard;
  const standing =
    guard !== undefined &&
    guard.retiredAt === undefined &&
    asserted !== undefined &&
    upheld.some((p) => sameProposition(p, asserted));
  return {
    decision: row.decision,
    // The Projector records an arrival on the feed before it folds it, so only a store the feed never numbered answers `D-0`.
    label: labelGiven(store, row.project, "D-", row.decision.id) ?? "D-0",
    project: row.project,
    ...(row.conflictId === undefined ? {} : { conflictId: row.conflictId }),
    ...(conflict?.subjectId === undefined ? {} : { subjectId: conflict.subjectId }),
    ...(conflict?.subjectKey === undefined ? {} : { subjectKey: conflict.subjectKey }),
    holds: upheld,
    ...(resolved?.against === undefined ? {} : { against: resolved.against }),
    guards: standing ? [guard.id] : [],
  };
}

/** A decision as the index reads it, joined; undefined for one it has not heard recorded. */
export function indexedDecision(store: Store, decisionId: string): IndexedDecision | undefined {
  const row = rowOf(store, decisionId);
  return row === undefined ? undefined : joined(store, row);
}

/** A project's decisions, joined, newest first. */
const decisionsOf = (store: Store, project: ProjectId): readonly IndexedDecision[] =>
  store
    .list(DECISION_INDEX.project(project))
    .flatMap(({ id }) => indexedDecision(store, id) ?? [])
    .toSorted(
      (a, b) =>
        b.decision.decidedAt - a.decision.decidedAt || b.decision.id.localeCompare(a.decision.id),
    );

/** One decision, joined. DecisionNotFound for one the index has not heard recorded. */
export const getDecision: (
  decisionId: DecisionId,
) => Effect.Effect<IndexedDecision, DecisionNotFound, EntityStore> = Effect.fn(
  "memory/getDecision",
)(function* (decisionId: DecisionId) {
  const store = yield* EntityStore;
  const found = store.transaction(() => indexedDecision(store, decisionId));
  return found ?? (yield* new DecisionNotFound({ decisionId }));
});

/** A project's decisions, newest first, on one subject when asked, from after `cursor`. */
export const listDecisions: (
  read: DecisionListRead,
) => Effect.Effect<DecisionListPage, never, EntityStore> = Effect.fn("memory/listDecisions")(
  function* (read: DecisionListRead) {
    const store = yield* EntityStore;
    const limit = Math.min(Math.max(read.limit ?? DECISION_PAGE, 1), DECISION_PAGE_MAX);
    const matching = store
      .transaction(() => decisionsOf(store, read.project))
      .filter((d) => read.subject === undefined || d.subjectKey === read.subject);
    const after =
      read.cursor === undefined ? 0 : matching.findIndex((d) => d.decision.id === read.cursor) + 1;
    const rest = matching.slice(after);
    const items = rest.slice(0, limit);
    const last = items.at(-1);
    return rest.length > limit && last !== undefined
      ? { items, nextCursor: last.decision.id }
      : { items };
  },
);

/** The decision each guard holds, by the conflict it was admitted from; a guard that holds none is left out. */
export const decisionsOfGuards: (
  project: ProjectId,
  guardIds: readonly GuardId[],
) => Effect.Effect<readonly GuardDecision[], never, EntityStore> = Effect.fn(
  "memory/decisionsOfGuards",
)(function* (project: ProjectId, guardIds: readonly GuardId[]) {
  const store = yield* EntityStore;
  return store.transaction(() =>
    guardIds.flatMap((guardId) => {
      const conflictId = store.get(CONFLICT_VIEWS.guard(project), guardId);
      const decisionId =
        typeof conflictId === "string"
          ? store.get(DECISION_INDEX.conflict(project), conflictId)
          : undefined;
      const decision =
        typeof decisionId === "string" ? indexedDecision(store, decisionId) : undefined;
      return decision?.guards.includes(guardId) === true ? [{ guardId, decision }] : [];
    }),
  );
});

/** A project's decisions on any of these subjects, newest first. */
export const decisionsOnSubjects: (
  project: ProjectId,
  subjects: readonly SubjectKey[],
) => Effect.Effect<readonly IndexedDecision[], never, EntityStore> = Effect.fn(
  "memory/decisionsOnSubjects",
)(function* (project: ProjectId, subjects: readonly SubjectKey[]) {
  const store = yield* EntityStore;
  const wanted: ReadonlySet<string> = new Set(subjects);
  return store
    .transaction(() => decisionsOf(store, project))
    .filter((d) => d.subjectKey !== undefined && wanted.has(d.subjectKey));
});
