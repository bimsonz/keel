import { Effect, Result, Schema } from "effect";
import {
  Change,
  ChangeEvent,
  ChangeNotFound,
  evolveChange,
} from "../../domain/coordination/index.ts";
import { TrunkAdvanced, TrunkInitialized } from "../../domain/integration/index.ts";
import {
  type ChangeId,
  type EventEnvelope,
  IllegalTransition,
  type ProjectId,
} from "../../domain/kernel/index.ts";
import {
  type ChangeListPage,
  type ChangeListRead,
  ChangeSummary,
  type ChangeView,
  EntityStore,
  type Stored,
  TrunkView,
  type ViewSnapshot,
} from "../ports/index.ts";
import { foldConflictViews, foldsConflict } from "./conflict-views.ts";
import { foldDecisionIndex, foldsDecision, foldSubjectAnchors } from "./decision-index.ts";
import { foldEscalationViews, foldsEscalation } from "./escalation-views.ts";
import { FEED, feedCursor } from "./feed.ts";

/**
 * The Projector's read models beside the feed: each change folded by the
 * domain's own `evolveChange`, a summary of it per project, and each project's
 * trunk (its conflicts are `conflict-views.ts`). Folded in the receipt's
 * transaction, so they hold exactly the events the feed holds up to its head.
 */
export const VIEWS = {
  /** The change as its events leave it, by change id. */
  change: "change-view",
  /** One kind per project, so a project's list reads only its own changes. */
  summary: (project: ProjectId) => `change-summary:${project}`,
  /** A project's trunk head and height, by project id. */
  trunk: "trunk-view",
} as const;

export const CHANGE_PAGE = 50;
export const CHANGE_PAGE_MAX = 100;

type Store = (typeof EntityStore)["Service"];

const decodeChangeEvent = Schema.decodeUnknownResult(ChangeEvent);
const decodeTrunkEvent = Schema.decodeUnknownResult(
  Schema.Union([TrunkInitialized, TrunkAdvanced]),
);
const decodeChange = Schema.decodeUnknownSync(Change);
const encodeChange = Schema.encodeSync(Change);
const decodeSummary = Schema.decodeUnknownSync(ChangeSummary);
const encodeSummary = Schema.encodeSync(ChangeSummary);
const decodeTrunk = Schema.decodeUnknownSync(TrunkView);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

/** The `#n` the feed gave the change when its IntentDeclared arrived. */
const numberOf = (store: Store, project: ProjectId, changeId: string): number | undefined => {
  const label = store.get(FEED.given, `${project}/#/${changeId}`);
  return typeof label === "string" ? Number(label.slice(1)) : undefined;
};

function foldChange(store: Store, event: EventEnvelope): string | undefined {
  const decoded = decodeChangeEvent(event.payload);
  if (Result.isFailure(decoded)) return `${event.eventId} (${event.type}) is not a change event`;
  const stored = store.get(VIEWS.change, event.entity.id);
  let change: Change;
  try {
    change = evolveChange(stored === undefined ? undefined : decodeChange(stored), {
      at: event.at,
      payload: decoded.success,
    });
  } catch (error) {
    if (error instanceof IllegalTransition) return `${event.eventId}: ${error.message}`;
    throw error;
  }
  store.put(VIEWS.change, change.id, asStored(encodeChange(change)));
  const { project } = event;
  if (project === undefined) return undefined;
  const number = numberOf(store, project, change.id);
  if (number === undefined) return `${change.id} has no #n in ${project}`;
  const summary: ChangeSummary = {
    changeId: change.id,
    number,
    state: change.state,
    ...(change.parkReason === undefined ? {} : { parkReason: change.parkReason }),
    agentId: change.agentId,
    goal: change.intent.goal,
    revision: change.intent.revision,
    declaredAt: change.createdAt,
    updatedAt: event.at,
  };
  store.put(VIEWS.summary(project), change.id, asStored(encodeSummary(summary)));
  return undefined;
}

function foldTrunk(store: Store, event: EventEnvelope): string | undefined {
  const decoded = decodeTrunkEvent(event.payload);
  if (Result.isFailure(decoded)) return `${event.eventId} (${event.type}) is not a trunk event`;
  const payload = decoded.success;
  const stored = store.get(VIEWS.trunk, payload.projectId);
  const before = stored === undefined ? undefined : decodeTrunk(stored);
  const trunk: TrunkView =
    payload._tag === "TrunkInitialized"
      ? { head: payload.head, height: 0 }
      : { head: payload.to, height: payload.height ?? (before?.height ?? 0) + 1 };
  store.put(VIEWS.trunk, payload.projectId, asStored(trunk));
  return undefined;
}

/** What a change records of the precedents it was shown and answered, beside its own machine's events. */
const STANCES: ReadonlySet<string> = new Set(["PrecedentSurfaced", "PrecedentDistinguished"]);

/**
 * Folds an arrived event into the read models, in the receipt's transaction
 * after `recordFeed`. An event a model cannot take (undecodable, or one the
 * change machine calls illegal) leaves the models as they were and comes back
 * as a problem for the caller to log: the feed keeps the event, and the
 * receipt never fails, so nothing is owed for ever.
 */
export function foldViews(store: Store, event: EventEnvelope): string | undefined {
  // A ruling's decision is both the escalation's answer and the index's row.
  const decided = foldsDecision(event) ? foldDecisionIndex(store, event) : undefined;
  if (foldsEscalation(event)) return foldEscalationViews(store, event) ?? decided;
  // A change's bounce over a conflict, or a conflict noted on it, is also what the conflict's view shows its party was told.
  const conflict = foldsConflict(event) ? foldConflictViews(store, event) : undefined;
  // A change's stance on a precedent is its own fact, in the feed: no view holds it yet.
  if (event.entity.kind === "change" && STANCES.has(event.type)) return conflict;
  if (event.entity.kind === "change") return foldChange(store, event) ?? conflict;
  if (event.type === "TrunkInitialized" || event.type === "TrunkAdvanced")
    return foldTrunk(store, event);
  // Where a subject is anchored is the decision index's, read by path.
  if (event.type === "SubjectMinted") return foldSubjectAnchors(store, event);
  return conflict;
}

const summariesOf = (store: Store, project: ProjectId): ChangeSummary[] =>
  store
    .list(VIEWS.summary(project))
    .map(({ value }) => decodeSummary(value))
    .toSorted((a, b) => b.number - a.number);

/** A project's changes, newest `#n` first, in one state when asked, from below `cursor`. */
export const listChanges: (
  read: ChangeListRead,
) => Effect.Effect<ChangeListPage, never, EntityStore> = Effect.fn("memory/listChanges")(function* (
  read: ChangeListRead,
) {
  const store = yield* EntityStore;
  const limit = Math.min(Math.max(read.limit ?? CHANGE_PAGE, 1), CHANGE_PAGE_MAX);
  const below = read.cursor;
  const matching = summariesOf(store, read.project).filter(
    (summary) =>
      (read.state === undefined || summary.state === read.state) &&
      (below === undefined || summary.number < below),
  );
  const items = matching.slice(0, limit);
  const last = items.at(-1);
  return matching.length > limit && last !== undefined
    ? { items, nextCursor: last.number }
    : { items };
});

/**
 * One change of a project as folded, with when its last event was. The change
 * row is by id alone, so the project's summary of it is what places it there:
 * ChangeNotFound for a change the project's feed has not seen declared.
 */
export const changeView: (
  project: ProjectId,
  changeId: ChangeId,
) => Effect.Effect<ChangeView, ChangeNotFound, EntityStore> = Effect.fn("memory/changeView")(
  function* (project: ProjectId, changeId: ChangeId) {
    const store = yield* EntityStore;
    const found = store.transaction(() => {
      const summary = store.get(VIEWS.summary(project), changeId);
      const change = store.get(VIEWS.change, changeId);
      return summary === undefined || change === undefined
        ? undefined
        : { change: decodeChange(change), updatedAt: decodeSummary(summary).updatedAt };
    });
    return found ?? (yield* new ChangeNotFound({ changeId }));
  },
);

/** The project's changes and trunk with the feed's head, read in one transaction. */
export const viewSnapshot: (project: ProjectId) => Effect.Effect<ViewSnapshot, never, EntityStore> =
  Effect.fn("memory/viewSnapshot")(function* (project: ProjectId) {
    const store = yield* EntityStore;
    return store.transaction(() => {
      const stored = store.get(VIEWS.trunk, project);
      return {
        cursor: feedCursor(store),
        changes: summariesOf(store, project),
        ...(stored === undefined ? {} : { trunk: decodeTrunk(stored) }),
      };
    });
  });
