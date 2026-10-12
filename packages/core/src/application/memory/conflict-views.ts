import { Effect, Result, Schema } from "effect";
import { ChangeBounced, ConflictNoted } from "../../domain/coordination/index.ts";
import {
  type ChangeId,
  type ConflictId,
  type EventEnvelope,
  IllegalTransition,
  type Instant,
  type ProbeId,
  type ProjectId,
} from "../../domain/kernel/index.ts";
import {
  ConflictDismissed,
  ConflictEscalated,
  ConflictNotFound,
  ConflictProven,
  ConflictResolved,
  type ConflictState,
  ConflictSuspected,
  evolveConflict,
  evolveProbe,
  GuardAdmitted,
  GuardRetired,
  ProbeDiscarded,
  ProbeDrafted,
  ProbeNotFound,
  ProbeRan,
  type World,
  WorldCheckRan,
} from "../../domain/verification/index.ts";
import {
  ConflictFolded,
  type ConflictListPage,
  type ConflictListRead,
  type ConflictRecord,
  EntityStore,
  type ProbeRunView,
  type Stored,
  ToldView,
  type WorldCheckView,
} from "../ports/index.ts";
import { FEED } from "./feed.ts";

/**
 * The Projector's read model of a project's conflicts, beside its change
 * views: each conflict folded from its own events by the domain's
 * `evolveConflict` and `evolveProbe`, with what those entities drop. One kind
 * per project, so a project's list reads only its own conflicts.
 */
export const CONFLICT_VIEWS = {
  /** The conflict as its events leave it, by conflict id. */
  conflict: (project: ProjectId) => `conflict-view:${project}`,
  /** The conflict a probe is of, by probe id: a discarded probe's event may not name it. */
  probe: (project: ProjectId) => `conflict-probe:${project}`,
  /** The conflict a guard came from, by guard id: GuardRetired names only the guard. */
  guard: (project: ProjectId) => `conflict-guard:${project}`,
  /** What a party was last told about a conflict, by `<conflictId>/<changeId>`. */
  told: (project: ProjectId) => `conflict-told:${project}`,
} as const;

export const CONFLICT_PAGE = 50;
export const CONFLICT_PAGE_MAX = 100;

/** The worlds of a conflict's matrix, in the order they are shown: trunk, the control, each side, both. */
export const MATRIX_WORLDS: readonly World[] = ["trunk", "A-noop", "A", "B", "AB"];

/** A conflict is settled once it is dismissed or resolved; in every other state it is open. */
export const isOpenConflict = (state: ConflictState): boolean =>
  state !== "dismissed" && state !== "resolved";

type Store = (typeof EntityStore)["Service"];

/** Every event the conflict view folds: the conflict's own, its probe's and its guard's. */
const ConflictViewEvent = Schema.Union([
  ConflictSuspected,
  ProbeDrafted,
  ProbeRan,
  WorldCheckRan,
  ProbeDiscarded,
  GuardAdmitted,
  GuardRetired,
  ConflictProven,
  ConflictDismissed,
  ConflictEscalated,
  ConflictResolved,
]);
type ConflictViewEvent = typeof ConflictViewEvent.Type;

/** The same events by name; the record is exhaustive over the union, so a new member cannot be left out of one. */
const CONFLICT_VIEW_TYPES: Readonly<Record<ConflictViewEvent["_tag"], true>> = {
  ConflictSuspected: true,
  ProbeDrafted: true,
  ProbeRan: true,
  WorldCheckRan: true,
  ProbeDiscarded: true,
  GuardAdmitted: true,
  GuardRetired: true,
  ConflictProven: true,
  ConflictDismissed: true,
  ConflictEscalated: true,
  ConflictResolved: true,
};
const isConflictViewType = (type: string): boolean => Object.hasOwn(CONFLICT_VIEW_TYPES, type);

const decodeEvent = Schema.decodeUnknownResult(ConflictViewEvent);
const decodeToldEvent = Schema.decodeUnknownResult(Schema.Union([ChangeBounced, ConflictNoted]));
const decodeFolded = Schema.decodeUnknownSync(ConflictFolded);
const encodeFolded = Schema.encodeSync(ConflictFolded);
const decodeTold = Schema.decodeUnknownSync(ToldView);
const encodeTold = Schema.encodeSync(ToldView);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

/** The conflict an event is about: named on it, or found through its probe or its guard. */
function conflictOf(
  store: Store,
  project: ProjectId,
  event: ConflictViewEvent,
): string | undefined {
  if (event._tag === "GuardRetired") {
    const found = store.get(CONFLICT_VIEWS.guard(project), event.guardId);
    return typeof found === "string" ? found : undefined;
  }
  if (event._tag === "ProbeDiscarded" && event.conflictId === undefined) {
    const found = store.get(CONFLICT_VIEWS.probe(project), event.probeId);
    return typeof found === "string" ? found : undefined;
  }
  return event.conflictId;
}

/** One event folded into the conflict; the domain's machines throw `IllegalTransition` for one they would not have committed. */
function step(
  before: ConflictFolded | undefined,
  event: ConflictViewEvent,
  at: Instant,
): ConflictFolded {
  if (before === undefined) {
    if (event._tag !== "ConflictSuspected")
      throw new IllegalTransition(`${event._tag} arrived before its conflict was suspected`);
    return {
      conflict: evolveConflict(undefined, { at, payload: event }),
      runs: [],
      checks: [],
    };
  }
  switch (event._tag) {
    case "ConflictSuspected":
      return { ...before, conflict: evolveConflict(before.conflict, { at, payload: event }) };
    case "ProbeDrafted":
      return {
        ...before,
        conflict: evolveConflict(before.conflict, { at, payload: event }),
        probe: evolveProbe(before.probe, { at, payload: event }),
      };
    case "ProbeRan": {
      const run: ProbeRunView = {
        world: event.world,
        run: event.run,
        outcome: event.outcome,
        resultRef: event.resultRef,
        at,
      };
      return {
        ...before,
        conflict: evolveConflict(before.conflict, { at, payload: event }),
        probe: evolveProbe(before.probe, { at, payload: event }),
        runs: [...before.runs, run],
      };
    }
    case "WorldCheckRan": {
      const check: WorldCheckView = {
        world: event.world,
        check: event.check,
        run: event.run,
        outcome: event.outcome,
        ...(event.counts === undefined ? {} : { counts: event.counts }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        at,
      };
      return {
        ...before,
        conflict: evolveConflict(before.conflict, { at, payload: event }),
        checks: [...before.checks, check],
      };
    }
    case "ProbeDiscarded":
      return {
        ...before,
        probe: evolveProbe(before.probe, { at, payload: event }),
        ...(event.detail === undefined ? {} : { draftFailure: event.detail }),
      };
    case "GuardAdmitted":
      return {
        ...before,
        probe: evolveProbe(before.probe, { at, payload: event }),
        guard: { id: event.guardId, probeId: event.probeId, runs: event.runs, admittedAt: at },
      };
    case "GuardRetired":
      return {
        ...before,
        probe: evolveProbe(before.probe, { at, payload: event }),
        ...(before.guard === undefined ? {} : { guard: { ...before.guard, retiredAt: at } }),
      };
    case "ConflictProven":
      return {
        ...before,
        conflict: evolveConflict(before.conflict, { at, payload: event }),
        proven: event.evidence,
      };
    case "ConflictDismissed":
      return {
        ...before,
        conflict: evolveConflict(before.conflict, { at, payload: event }),
        dismissed: event.evidence,
        settledAt: at,
      };
    case "ConflictEscalated":
      return {
        ...before,
        conflict: evolveConflict(before.conflict, { at, payload: event }),
        escalated: event.reason,
      };
    case "ConflictResolved":
      return {
        ...before,
        conflict: evolveConflict(before.conflict, { at, payload: event }),
        settledAt: at,
      };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

function foldConflict(store: Store, event: EventEnvelope): string | undefined {
  const { project } = event;
  if (project === undefined) return `${event.eventId} (${event.type}) names no project`;
  const decoded = decodeEvent(event.payload);
  if (Result.isFailure(decoded))
    return `${event.eventId} (${event.type}) is not a conflict or probe event`;
  const payload = decoded.success;
  const conflictId = conflictOf(store, project, payload);
  if (conflictId === undefined)
    return `${event.eventId} (${event.type}) names no conflict this feed has seen`;
  const stored = store.get(CONFLICT_VIEWS.conflict(project), conflictId);
  let folded: ConflictFolded;
  try {
    folded = step(stored === undefined ? undefined : decodeFolded(stored), payload, event.at);
  } catch (error) {
    if (error instanceof IllegalTransition) return `${event.eventId}: ${error.message}`;
    throw error;
  }
  if (labelOf(store, project, "C-", conflictId) === undefined)
    return `${conflictId} has no C-n in ${project}`;
  store.put(CONFLICT_VIEWS.conflict(project), conflictId, asStored(encodeFolded(folded)));
  if (payload._tag === "ProbeDrafted" || payload._tag === "ProbeDiscarded")
    store.put(CONFLICT_VIEWS.probe(project), payload.probeId, conflictId);
  if (payload._tag === "GuardAdmitted")
    store.put(CONFLICT_VIEWS.guard(project), payload.guardId, conflictId);
  return undefined;
}

/**
 * Notes what a party's change was told about a conflict: a bounce citing it,
 * or a note of it. Kept beside the conflict, not in it, because the change's
 * event and the conflict's come from different objects in no fixed order.
 */
function foldTold(store: Store, event: EventEnvelope): string | undefined {
  const { project } = event;
  if (project === undefined) return undefined;
  const decoded = decodeToldEvent(event.payload);
  if (Result.isFailure(decoded)) return `${event.eventId} (${event.type}) does not decode`;
  const payload = decoded.success;
  if (payload.conflictId === undefined) return undefined;
  const told: ToldView = {
    changeId: payload.changeId,
    how: payload._tag === "ChangeBounced" ? "bounced" : "noted",
    nextActions: payload.nextActions ?? [],
    at: event.at,
  };
  store.put(
    CONFLICT_VIEWS.told(project),
    `${payload.conflictId}/${payload.changeId}`,
    asStored(encodeTold(told)),
  );
  return undefined;
}

/** Whether the conflict view folds this event at all. */
export const foldsConflict = (event: EventEnvelope): boolean =>
  isConflictViewType(event.type) ||
  event.type === "ChangeBounced" ||
  event.type === "ConflictNoted";

/**
 * Folds one arrived event into the project's conflict view, in the receipt's
 * transaction after `recordFeed`. An event it cannot take (undecodable, out of
 * the domain's order, of no project) leaves the view as it was and comes back
 * as a problem for the caller to log.
 */
export function foldConflictViews(store: Store, event: EventEnvelope): string | undefined {
  return isConflictViewType(event.type) ? foldConflict(store, event) : foldTold(store, event);
}

/** The short label the feed gave something in a project, when it has recorded its creation. */
function labelOf(
  store: Store,
  project: ProjectId,
  prefix: string,
  id: string | undefined,
): string | undefined {
  if (id === undefined) return undefined;
  const label = store.get(FEED.given, `${project}/${prefix}/${id}`);
  return typeof label === "string" ? label : undefined;
}

function recordOf(store: Store, project: ProjectId, folded: ConflictFolded): ConflictRecord {
  const { conflict, probe, guard } = folded;
  const label = labelOf(store, project, "C-", conflict.id) ?? "C-0";
  const labels = {
    conflict: label,
    probe: labelOf(store, project, "P-", probe?.id),
    guard: labelOf(store, project, "G-", guard?.id),
    escalation: labelOf(store, project, "E-", conflict.escalationId),
    decision: labelOf(store, project, "D-", conflict.decisionId),
  };
  const told = conflict.parties.flatMap((party) => {
    const stored = store.get(CONFLICT_VIEWS.told(project), `${conflict.id}/${party}`);
    return stored === undefined ? [] : [decodeTold(stored)];
  });
  return {
    ...folded,
    number: Number(label.slice(2)),
    labels: {
      conflict: labels.conflict,
      ...(labels.probe === undefined ? {} : { probe: labels.probe }),
      ...(labels.guard === undefined ? {} : { guard: labels.guard }),
      ...(labels.escalation === undefined ? {} : { escalation: labels.escalation }),
      ...(labels.decision === undefined ? {} : { decision: labels.decision }),
    },
    told,
  };
}

const partyTo = (record: ConflictRecord, changeId: ChangeId): boolean =>
  record.conflict.parties.some((party) => party === changeId);

/**
 * A project's conflicts, newest `C-n` first: open or settled when asked, in
 * one state when asked, of one change when asked, from below `cursor`. The
 * totals count the project's conflicts (the change's, when one is named) by
 * open and settled, whatever else the read filters by.
 */
export const listConflicts: (
  read: ConflictListRead,
) => Effect.Effect<ConflictListPage, never, EntityStore> = Effect.fn("memory/listConflicts")(
  function* (read: ConflictListRead) {
    const store = yield* EntityStore;
    const limit = Math.min(Math.max(read.limit ?? CONFLICT_PAGE, 1), CONFLICT_PAGE_MAX);
    const { changeId, cursor: below } = read;
    const counted = store
      .list(CONFLICT_VIEWS.conflict(read.project))
      .map(({ value }) => recordOf(store, read.project, decodeFolded(value)))
      .filter((record) => changeId === undefined || partyTo(record, changeId))
      .toSorted((a, b) => b.number - a.number);
    const open = counted.filter((record) => isOpenConflict(record.conflict.state)).length;
    const matching = counted.filter(
      (record) =>
        (read.open === undefined || isOpenConflict(record.conflict.state) === read.open) &&
        (read.state === undefined || record.conflict.state === read.state) &&
        (below === undefined || record.number < below),
    );
    const items = matching.slice(0, limit);
    const last = items.at(-1);
    const totals = { open, settled: counted.length - open };
    return matching.length > limit && last !== undefined
      ? { items, nextCursor: last.number, totals }
      : { items, totals };
  },
);

/** One conflict of a project as the feed has folded it, with its labels and what its parties were told. */
export const conflictRecord: (
  project: ProjectId,
  conflictId: ConflictId,
) => Effect.Effect<ConflictRecord, ConflictNotFound, EntityStore> = Effect.fn(
  "memory/conflictRecord",
)(function* (project: ProjectId, conflictId: ConflictId) {
  const store = yield* EntityStore;
  const stored = store.get(CONFLICT_VIEWS.conflict(project), conflictId);
  if (stored === undefined) return yield* new ConflictNotFound({ conflictId });
  return recordOf(store, project, decodeFolded(stored));
});

/**
 * The conflict a probe of a project belongs to, as `conflictRecord` answers
 * it. ProbeNotFound for a probe the project's feed has not seen drafted or
 * discarded, which is also a probe of another project.
 */
export const probeConflict: (
  project: ProjectId,
  probeId: ProbeId,
) => Effect.Effect<ConflictRecord, ProbeNotFound, EntityStore> = Effect.fn("memory/probeConflict")(
  function* (project: ProjectId, probeId: ProbeId) {
    const store = yield* EntityStore;
    const conflictId = store.get(CONFLICT_VIEWS.probe(project), probeId);
    const stored =
      typeof conflictId === "string"
        ? store.get(CONFLICT_VIEWS.conflict(project), conflictId)
        : undefined;
    if (stored === undefined) return yield* new ProbeNotFound({ probeId });
    return recordOf(store, project, decodeFolded(stored));
  },
);

/** One world of a conflict's matrix: the probe's runs there in run order, and each suite's latest run. */
export interface MatrixWorld {
  readonly world: World;
  readonly probe: readonly ProbeRunView[];
  readonly checks: readonly WorldCheckView[];
}

/**
 * The conflict's world matrix: always the five worlds, in `MATRIX_WORLDS`
 * order, each with what Keel has recorded there and nothing where it has
 * recorded nothing. A suite run again in a world is shown by its latest run.
 */
export const matrixOf = (record: ConflictRecord): readonly MatrixWorld[] =>
  MATRIX_WORLDS.map((world) => {
    const latest = new Map<string, WorldCheckView>();
    for (const check of record.checks) {
      if (check.world !== world) continue;
      const standing = latest.get(check.check);
      if (standing === undefined || check.run > standing.run) latest.set(check.check, check);
    }
    return {
      world,
      probe: record.runs.filter((run) => run.world === world).toSorted((a, b) => a.run - b.run),
      checks: [...latest.values()].toSorted((a, b) => a.check.localeCompare(b.check)),
    };
  });

/** One side of a conflict as Keel knows it: the change, what it holds on the contested subject, and what it was told. */
export interface ConflictSide {
  readonly changeId: ChangeId;
  readonly role: "premise" | "effect";
  readonly proposition: NonNullable<ConflictRecord["conflict"]["premise"]>["proposition"];
  readonly told?: ToldView;
}

/**
 * The two sides, when the conflict's suspicion named them: `holder` relies on
 * the premise (world A of the matrix) and `other` makes the effect that
 * breaks it (world B). A conflict suspected without them has no sides.
 */
export const sidesOf = (
  record: ConflictRecord,
): { readonly holder: ConflictSide; readonly other: ConflictSide } | undefined => {
  const { premise, effect } = record.conflict;
  if (premise === undefined || effect === undefined) return undefined;
  const toldTo = (changeId: ChangeId) => {
    const told = record.told.find((entry) => entry.changeId === changeId);
    return told === undefined ? {} : { told };
  };
  return {
    holder: {
      changeId: premise.holder,
      role: "premise",
      proposition: premise.proposition,
      ...toldTo(premise.holder),
    },
    other: {
      changeId: effect.changeId,
      role: "effect",
      proposition: effect.proposition,
      ...toldTo(effect.changeId),
    },
  };
};
