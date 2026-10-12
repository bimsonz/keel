import { Effect, Result, Schema } from "effect";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import {
  type ConflictId,
  type EntityRef,
  type Instant,
  ProbeId,
  type ProjectId,
} from "../../domain/kernel/index.ts";
import {
  Conflict,
  type ConflictCommand,
  ConflictEvent,
  ConflictNotFound,
  type ConflictRejection,
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
import { affectingParties, PARTY_HEARS, subscribeParties } from "./party-conflicts.ts";
import { hashedIdBody } from "./hashed-id.ts";

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

export const conflictRef = (id: ConflictId): EntityRef => ({ kind: "conflict", id });

const PARTY_MOVES: ReadonlySet<string> = new Set(PARTY_HEARS);

/** A conflict's event as a draft: a move its parties hear names them as affected, so each party's scoped subscription takes it. */
const ledgerDraft = (
  payload: typeof ConflictEvent.Type | typeof ProbeEvent.Type,
  conflict: Conflict,
): EventDraft => ({
  payload: payloadOf(encodeLedgerEvent(payload)),
  ...(PARTY_MOVES.has(payload._tag) ? { affected: affectingParties(conflict.parties) } : {}),
});
const probeRef = (id: ProbeId): EntityRef => ({ kind: "probe", id });

export const storedConflict = (store: Store, conflictId: ConflictId): Conflict | undefined => {
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

export const viewOf = (store: Store, conflictId: ConflictId): ConflictView | undefined => {
  const conflict = storedConflict(store, conflictId);
  if (conflict === undefined) return undefined;
  const probe = probeOf(store, conflictId);
  return probe === undefined ? { conflict } : { conflict, probe };
};

/**
 * One decision of the conflict's or its probe's machine, with the other entity
 * as its fact, and every event folded into each entity that takes it (the
 * conflict folds ProbeDrafted and ProbeRan): the two machines in one object,
 * as the domain plays them. Every event lands on the commit's entity; a
 * settle after a probe step names the conflict itself (`settleStep`).
 */
export function ledgerStep(
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
    drafts.push(ledgerDraft(payload, conflict));
  }
  tx.store.put(CONFLICT, conflictId, asStored(encodeConflict(conflict)));
  if (probe !== undefined) {
    tx.store.put(PROBE, probe.id, asStored(encodeProbe(probe)));
    tx.store.put(CONFLICT_PROBE, conflictId, probe.id);
  }
  return Result.succeed(drafts);
}

/**
 * The conflict's Settle once a probe step has decided its probe (admitted, or
 * discarded), in the same transaction, since the Subject DO never hears its
 * own events. Proven or dismissed lands on the conflict's own entity. A settle
 * the machine refuses (the probe still pending, or an unprovable probe that
 * needs an escalation) commits nothing here and leaves the conflict open: a
 * transaction cannot ask a person, so `escalateUnprovable` raises the
 * escalation once this one has committed, and settles with its id.
 */
function settleStep(
  tx: Transaction,
  conflictId: ConflictId,
): Result.Result<readonly EventDraft[], LedgerRefusal> {
  const probe = probeOf(tx.store, conflictId);
  if (probe?.state !== "admitted" && probe?.state !== "discarded") return Result.succeed([]);
  const settled = ledgerStep(tx, conflictId, { _tag: "Conflict", command: { _tag: "Settle" } });
  if (Result.isFailure(settled))
    return settled.failure._tag === "ConflictStateRefused" ? Result.succeed([]) : settled;
  return Result.succeed(
    settled.success.map((draft) => ({ ...draft, entity: conflictRef(conflictId) })),
  );
}

/**
 * The one probe a conflict's drafting begins, named from the conflict: a
 * conflict is probed once (the machine drafts only for a suspected conflict
 * with no probe), so a repeated draft or failure lands on the same entity and
 * is answered by its cause.
 */
export const probeIdOf = (conflictId: ConflictId): ProbeId =>
  ProbeId.make(`prb_${hashedIdBody(conflictId)}`);

/**
 * Commits one ledger step on `entity` under `cause`, and after a probe step
 * the conflict's settle; a replay answers the conflict as it stands, a reused
 * cause with another body is an IdempotencyConflict.
 */
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
      Result.flatMap(ledgerStep(tx, conflictId, step), (drafts) =>
        Result.map(
          step._tag === "Probe" ? settleStep(tx, conflictId) : Result.succeed([]),
          (settled) => ({
            drafts: [...drafts, ...settled],
            value: undefined,
          }),
        ),
      ),
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
 * The Probe Workflow's drafting ended without a probe to calibrate (it abstained, its
 * draft stayed incomplete, its repairs ran out, its worlds could not be
 * built, …): the probe begins and ends discarded as draft-failed, its
 * ProbeDiscarded carrying the reason as `detail`, so the conflict never waits
 * on a draft that will not come. Once per conflict, as `probeDrafted`. The
 * conflict stays open here: settling an unprovable probe needs an escalation,
 * which the subject raises next (`escalateUnprovable`).
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
    {
      _tag: "Probe",
      probeId,
      command: { _tag: "DraftFailed", conflictId: failed.conflictId, detail: failed.reason },
    },
  );
  return yield* conflictView(failed.conflictId);
});

/**
 * One world-matrix cell of the conflict's probe: ProbeRan, and GuardAdmitted
 * or ProbeDiscarded when the cells decide it, with the conflict settled by
 * that decision in the same transaction. The machine fences it (the
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
 * One check of a party's suite in one world: WorldCheckRan. The conflict
 * machine says when one is accepted, never before the conflict's probe is
 * drafted. Idempotent per (conflict, world, check, run) by the machine,
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
 * What opening a conflict commits, inside the caller's transaction: the
 * conflict's ConflictSuspected on `conflict:<cid>`, its row, and each party's
 * Change DO subscribed to its moves. A suspicion the domain refuses commits
 * nothing and answers the refusal. The Subject DO's fallout calls it from its
 * reaction, so it reads no clock: `at` is the caller's.
 */
export function suspectDrafts(
  tx: Pick<Transaction, "store" | "outbox">,
  at: Instant,
  conflictId: ConflictId,
  suspect: Extract<ConflictCommand, { _tag: "Suspect" }>,
): Result.Result<readonly EventDraft[], ConflictRejection> {
  const decided = decideConflict(storedConflict(tx.store, conflictId), suspect, {
    now: at,
    conflictId,
  });
  if (Result.isFailure(decided)) return Result.fail(decided.failure);
  let conflict: Conflict | undefined;
  const drafts: EventDraft[] = [];
  for (const payload of decided.success) {
    conflict = evolveConflict(conflict, { at, payload });
    drafts.push({ ...ledgerDraft(payload, conflict), entity: conflictRef(conflictId) });
  }
  if (conflict !== undefined) {
    tx.store.put(CONFLICT, conflictId, asStored(encodeConflict(conflict)));
    subscribeParties(tx.outbox, conflict.parties);
  }
  return Result.succeed(drafts);
}

/** Opens a conflict on this subject in a commit of its own, as the ledger's harnesses do. */
export const suspectConflict = Effect.fn("coordination/suspectConflict")(function* (
  projectId: ProjectId,
  conflictId: ConflictId,
  suspect: Extract<ConflictCommand, { _tag: "Suspect" }>,
) {
  yield* commit(
    { entity: conflictRef(conflictId), cause: `suspect:${conflictId}`, project: projectId },
    (tx) =>
      Result.map(suspectDrafts(tx, tx.at, conflictId, suspect), (drafts) => ({
        drafts,
        value: undefined,
      })),
  );
  return yield* conflictView(conflictId);
});
