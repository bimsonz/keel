import { Effect, Result, Schema } from "effect";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import {
  type ConflictId,
  type EntityRef,
  ProbeId,
  type ProjectId,
} from "../../domain/kernel/index.ts";
import {
  Conflict,
  type ConflictCommand,
  ConflictEvent,
  ConflictNotFound,
  decideConflict,
  decideProbe,
  evolveConflict,
  evolveProbe,
  Probe,
  type ProbeCommand,
  ProbeEvent,
} from "../../domain/verification/index.ts";
import { commit, type Transaction } from "../ports/commit.ts";
import type { EventDraft } from "../ports/event-outbox.ts";
import type { Stored } from "../ports/entity-store.ts";
import {
  type ConflictView,
  type DraftedProbe,
  EntityStore,
  type FailedDraft,
  Ids,
  type LedgerRefusal,
  type ProbeCell,
  type WorldCheckCell,
} from "../ports/index.ts";
import { hashedIdBody } from "./subject.ts";

type Store = Transaction["store"];

const CONFLICT = "conflict";
const PROBE = "probe";
/** The probe a conflict's drafting began, by conflict: a failed draft's probe is never folded into its conflict. */
const CONFLICT_PROBE = "conflict-probe";

const decodeConflict = Schema.decodeUnknownSync(Conflict);
const encodeConflict = Schema.encodeSync(Conflict);
const decodeProbe = Schema.decodeUnknownSync(Probe);
const encodeProbe = Schema.encodeSync(Probe);
const encodeLedgerEvent = Schema.encodeSync(Schema.Union([ConflictEvent, ProbeEvent]));
const isConflictEvent = Schema.is(ConflictEvent);
const isProbeEvent = Schema.is(ProbeEvent);
const payloadOf = (encoded: unknown): EventDraft["payload"] => JSON.parse(JSON.stringify(encoded));
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

const conflictRef = (id: ConflictId): EntityRef => ({ kind: "conflict", id });
const probeRef = (id: ProbeId): EntityRef => ({ kind: "probe", id });

const storedConflict = (store: Store, conflictId: ConflictId): Conflict | undefined => {
  const value = store.get(CONFLICT, conflictId);
  return value === undefined ? undefined : decodeConflict(value);
};

const storedProbe = (store: Store, probeId: string): Probe | undefined => {
  const value = store.get(PROBE, probeId);
  return value === undefined ? undefined : decodeProbe(value);
};

/** The probe drafted for a conflict, folded into it or not. */
const probeOf = (store: Store, conflictId: ConflictId): Probe | undefined => {
  const id = store.get(CONFLICT_PROBE, conflictId);
  return typeof id === "string" ? storedProbe(store, id) : undefined;
};

const viewOf = (store: Store, conflictId: ConflictId): ConflictView | undefined => {
  const conflict = storedConflict(store, conflictId);
  if (conflict === undefined) return undefined;
  const probe = probeOf(store, conflictId);
  return probe === undefined ? { conflict } : { conflict, probe };
};

/**
 * One decision of the conflict's or its probe's machine, with the other entity
 * as its fact, and every event folded into each entity that takes it (the
 * conflict folds ProbeDrafted and ProbeRan): the two machines in one object,
 * as the domain plays them. Every event lands on the step's entity: a probe
 * step's on the probe, a conflict step's on the conflict.
 */
function ledgerStep(
  tx: Transaction,
  conflictId: ConflictId,
  step:
    | { readonly _tag: "Conflict"; readonly command: ConflictCommand }
    | { readonly _tag: "Probe"; readonly probeId: ProbeId; readonly command: ProbeCommand },
): Result.Result<readonly EventDraft[], LedgerRefusal> {
  let conflict = storedConflict(tx.store, conflictId);
  if (conflict === undefined) return Result.fail(new ConflictNotFound({ conflictId }));
  let probe =
    step._tag === "Probe" ? storedProbe(tx.store, step.probeId) : probeOf(tx.store, conflictId);
  const decided: Result.Result<
    readonly (typeof ConflictEvent.Type | typeof ProbeEvent.Type)[],
    LedgerRefusal
  > =
    step._tag === "Conflict"
      ? decideConflict(conflict, step.command, {
          now: tx.at,
          conflictId,
          ...(probe === undefined ? {} : { probe }),
        })
      : decideProbe(probe, step.command, { now: tx.at, probeId: step.probeId, conflict });
  if (Result.isFailure(decided)) return Result.fail(decided.failure);
  const drafts: EventDraft[] = [];
  for (const payload of decided.success) {
    if (isConflictEvent(payload)) conflict = evolveConflict(conflict, { at: tx.at, payload });
    if (isProbeEvent(payload)) probe = evolveProbe(probe, { at: tx.at, payload });
    drafts.push({ payload: payloadOf(encodeLedgerEvent(payload)) });
  }
  tx.store.put(CONFLICT, conflictId, asStored(encodeConflict(conflict)));
  if (probe !== undefined) {
    tx.store.put(PROBE, probe.id, asStored(encodeProbe(probe)));
    tx.store.put(CONFLICT_PROBE, conflictId, probe.id);
  }
  return Result.succeed(drafts);
}

/**
 * The one probe a conflict's drafting begins, named from the conflict: a
 * conflict is probed once (the machine drafts only for a suspected conflict
 * with no probe), so a repeated draft or failure lands on the same entity and
 * is answered by its cause.
 */
export const probeIdOf = (conflictId: ConflictId): ProbeId =>
  ProbeId.make(`prb_${hashedIdBody(conflictId)}`);

/** Commits one ledger step on `entity` under `cause`; a replay answers the conflict as it stands, a reused cause with another body is an IdempotencyConflict. */
const ledgerCommit = (
  projectId: ProjectId,
  conflictId: ConflictId,
  entity: EntityRef,
  cause: string,
  fingerprint: string,
  step: Parameters<typeof ledgerStep>[2],
) =>
  Effect.flatMap(
    commit({ entity, cause, fingerprint, project: projectId }, (tx) =>
      Result.map(ledgerStep(tx, conflictId, step), (drafts) => ({ drafts, value: undefined })),
    ),
    (committed) =>
      committed.duplicate && !committed.sameCommand
        ? Effect.fail(new IdempotencyConflict({ idempotencyKey: cause }))
        : Effect.void,
  );

/** The conflict as it stands, with its probe. */
export const conflictView = (
  conflictId: ConflictId,
): Effect.Effect<ConflictView, ConflictNotFound, EntityStore> =>
  Effect.gen(function* () {
    const view = viewOf(yield* EntityStore, conflictId);
    return view === undefined ? yield* new ConflictNotFound({ conflictId }) : view;
  });

/**
 * The Probe Workflow drafted a probe for a suspected conflict: ProbeDrafted, and the
 * conflict starts probing it. Once per conflict: a repeat with the same bundle
 * answers the same, another bundle is an IdempotencyConflict, and a second
 * draft is refused by the machine.
 */
export const probeDrafted = Effect.fn("coordination/probeDrafted")(function* (
  projectId: ProjectId,
  drafted: DraftedProbe,
) {
  const probeId = probeIdOf(drafted.conflictId);
  yield* ledgerCommit(
    projectId,
    drafted.conflictId,
    probeRef(probeId),
    `probe-drafted:${drafted.conflictId}`,
    `${drafted.bundleHash}/${drafted.attempts}`,
    {
      _tag: "Probe",
      probeId,
      command: {
        _tag: "Draft",
        conflictId: drafted.conflictId,
        attempts: drafted.attempts,
        bundleHash: drafted.bundleHash,
      },
    },
  );
  return yield* conflictView(drafted.conflictId);
});

/**
 * The drafting ended without a probe to calibrate (it abstained, or its
 * draft stayed incomplete, or its repairs ran out): the probe begins and ends
 * discarded as draft-failed, so the conflict never waits on a draft that will
 * not come. Once per conflict, as `probeDrafted`. The reason is kept only in
 * the fingerprint until the domain's ProbeDiscarded carries it.
 */
export const probeDraftFailed = Effect.fn("coordination/probeDraftFailed")(function* (
  projectId: ProjectId,
  failed: FailedDraft,
) {
  const probeId = probeIdOf(failed.conflictId);
  yield* ledgerCommit(
    projectId,
    failed.conflictId,
    probeRef(probeId),
    `probe-draft-failed:${failed.conflictId}`,
    `${failed.reason}/${failed.attempts}`,
    { _tag: "Probe", probeId, command: { _tag: "DraftFailed", conflictId: failed.conflictId } },
  );
  return yield* conflictView(failed.conflictId);
});

/**
 * One world-matrix cell of the conflict's probe: ProbeRan, and GuardAdmitted
 * or ProbeDiscarded when the cells decide it. The machine fences it (the
 * conflict must be probing this probe, the run is 1–3) and keeps it
 * idempotent per (probe, world, run): the same outcome again commits nothing,
 * another is refused `cell-contradicts`.
 */
export const probeCellRan = Effect.fn("coordination/probeCellRan")(function* (
  projectId: ProjectId,
  cell: ProbeCell,
) {
  const guardId = yield* (yield* Ids).next("grd");
  yield* ledgerCommit(
    projectId,
    cell.conflictId,
    probeRef(cell.probeId),
    `probe-cell:${cell.probeId}:${cell.world}:${cell.run}:${cell.outcome}`,
    cell.resultRef,
    {
      _tag: "Probe",
      probeId: cell.probeId,
      command: {
        _tag: "Record",
        world: cell.world,
        run: cell.run,
        outcome: cell.outcome,
        resultRef: cell.resultRef,
        guardId,
      },
    },
  );
  return yield* conflictView(cell.conflictId);
});

/**
 * One check of a party's suite in one world while the conflict is probing:
 * WorldCheckRan. Idempotent per (conflict, world, check, run) by the machine,
 * which refuses a changed answer (`cell-recorded`) and a malformed cell.
 */
export const worldCheckRan = Effect.fn("coordination/worldCheckRan")(function* (
  projectId: ProjectId,
  cell: WorldCheckCell,
) {
  yield* ledgerCommit(
    projectId,
    cell.conflictId,
    conflictRef(cell.conflictId),
    `world-check:${cell.conflictId}:${cell.world}:${cell.check}:${cell.run}:${cell.outcome}`,
    JSON.stringify([cell.counts ?? null, cell.reason ?? null]),
    {
      _tag: "Conflict",
      command: {
        _tag: "RecordCheck",
        world: cell.world,
        check: cell.check,
        run: cell.run,
        outcome: cell.outcome,
        ...(cell.counts === undefined ? {} : { counts: cell.counts }),
        ...(cell.reason === undefined ? {} : { reason: cell.reason }),
      },
    },
  );
  return yield* conflictView(cell.conflictId);
});

/**
 * Opens a conflict on this subject: ConflictSuspected. Fallout calls it;
 * until then only the ledger's test harnesses do.
 */
export const suspectConflict = Effect.fn("coordination/suspectConflict")(function* (
  projectId: ProjectId,
  conflictId: ConflictId,
  suspect: Extract<ConflictCommand, { _tag: "Suspect" }>,
) {
  yield* commit(
    { entity: conflictRef(conflictId), cause: `suspect:${conflictId}`, project: projectId },
    (tx) => {
      const decided = decideConflict(storedConflict(tx.store, conflictId), suspect, {
        now: tx.at,
        conflictId,
      });
      if (Result.isFailure(decided)) return Result.fail(decided.failure);
      let conflict: Conflict | undefined;
      const drafts: EventDraft[] = [];
      for (const payload of decided.success) {
        conflict = evolveConflict(conflict, { at: tx.at, payload });
        drafts.push({ payload: payloadOf(encodeLedgerEvent(payload)) });
      }
      if (conflict !== undefined)
        tx.store.put(CONFLICT, conflictId, asStored(encodeConflict(conflict)));
      return Result.succeed({ drafts, value: undefined });
    },
  );
  return yield* conflictView(conflictId);
});
