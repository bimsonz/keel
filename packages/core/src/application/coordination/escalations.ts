import { Effect, Result, Schema } from "effect";
import type { Proposition } from "../../domain/coordination/index.ts";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import {
  type ConflictId,
  DecisionId,
  type EntityRef,
  EscalationId,
  OrgId,
  userActor,
} from "../../domain/kernel/index.ts";
import {
  Decision,
  DecisionRecorded,
  decideDecision,
  evolveDecision,
} from "../../domain/memory/index.ts";
import {
  type ConflictEscalated,
  decideEscalation,
  type Escalation,
  type EscalationEvidence,
  EscalationEvent,
  EscalationNotFound,
  evolveEscalation,
  type InvalidEscalation,
} from "../../domain/verification/index.ts";
import { commit, type Transaction, type Transition } from "../ports/commit.ts";
import type { EventDraft } from "../ports/event-outbox.ts";
import type { Stored } from "../ports/entity-store.ts";
import {
  type ConflictView,
  EntityStore,
  type EscalationAsk,
  EscalationRecord,
  type RaiseRequest,
  type RulingCommand,
  type RulingRefusal,
} from "../ports/index.ts";
import { hashedIdBody } from "./hashed-id.ts";

type Store = Transaction["store"];

/**
 * A conflict's one escalation, named from the conflict: whoever asks, and
 * however often, it is the same question to the same person.
 */
export const escalationIdOf = (conflictId: ConflictId): EscalationId =>
  EscalationId.make(`esc_${hashedIdBody(conflictId)}`);

/** The decision an escalation's ruling records, named from the escalation: one ruling, one decision. */
export const decisionIdOf = (escalationId: EscalationId): DecisionId =>
  DecisionId.make(`dec_${hashedIdBody(escalationId)}`);

const ADDRESS = "ns:";
const isNamespace = Schema.is(OrgId);

/** Where a namespace's object lives: `ns:<id>`. It hosts the escalations of the namespace's projects. */
export const namespaceAddress = (namespace: OrgId): string => `${ADDRESS}${namespace}`;

/** The namespace an object answers for, from its address; any other name throws. */
export const namespaceAt = (address: string | undefined): OrgId => {
  const namespace = address?.startsWith(ADDRESS) ? address.slice(ADDRESS.length) : undefined;
  if (!isNamespace(namespace)) throw new Error("a namespace's object is addressed as ns:<id>");
  return namespace;
};

/** The option that keeps the premise a change relies on. The default: the claim made first stands until a person says otherwise. */
export const PREMISE_HOLDS = "premise-holds";
/** The option that keeps the effect the other change makes. */
export const EFFECT_STANDS = "effect-stands";

/** A proposition as a person reads it: `authz.session freshness at-most per-request`. */
const said = (p: Proposition): string =>
  `${p.subject} ${p.predicate} ${p.relation} ${String(p.value)}${p.unit === undefined ? "" : ` ${p.unit}`}`;

const evidenceOf = (
  { conflict, probe }: ConflictView,
  note: string | undefined,
): readonly EscalationEvidence[] => {
  const evidence: EscalationEvidence[] = [];
  if (conflict.premise !== undefined)
    evidence.push({
      class: "testimony",
      summary: `${conflict.premise.holder} relies on: ${said(conflict.premise.proposition)}`,
      ref: `change:${conflict.premise.holder}`,
    });
  if (conflict.effect !== undefined) {
    const known = conflict.effect.evidence;
    evidence.push({
      class: known?.evidenceClass ?? "testimony",
      summary: `${conflict.effect.changeId} makes: ${said(conflict.effect.proposition)}${
        known === undefined || known.declared ? "" : ` (derived by ${known.method ?? "Keel"})`
      }`,
      ref: `change:${conflict.effect.changeId}`,
    });
  }
  if (probe?.state === "admitted")
    evidence.push({
      class: "proof",
      summary: `probe ${probe.id} tells the two changes apart`,
      ref: `probe:${probe.id}`,
    });
  if (probe?.state === "discarded")
    evidence.push({
      class: "ruling",
      summary: `probe ${probe.id} was discarded (${probe.discarded ?? "undecided"}): Keel could not prove the conflict either way`,
      ref: `probe:${probe.id}`,
    });
  if (note !== undefined && note.length > 0) evidence.push({ class: "testimony", summary: note });
  return evidence;
};

/**
 * What a person is asked about a conflict: which of its two sides holds. Two
 * options, each saying what it means for both changes; the default keeps the
 * premise. Keel asks; it never picks. A conflict whose suspicion named no
 * sides is asked about by its parties alone.
 */
export function askAbout(
  view: ConflictView,
  reason: (typeof ConflictEscalated.Type)["reason"],
  note?: string,
): EscalationAsk {
  const { conflict } = view;
  const { premise, effect } = conflict;
  const about: EntityRef = { kind: "conflict", id: conflict.id };
  const sides =
    premise === undefined || effect === undefined
      ? {
          question: `Conflict ${conflict.id} between ${conflict.parties.join(" and ")} needs a person: which side holds?`,
          premise: "the first party's claim",
          effect: "the second party's change",
          holder: conflict.parties[0] ?? "the first party",
          other: conflict.parties[1] ?? "the second party",
        }
      : {
          question: `${premise.holder} relies on "${said(premise.proposition)}", and ${effect.changeId} makes "${said(effect.proposition)}". Which holds?`,
          premise: said(premise.proposition),
          effect: said(effect.proposition),
          holder: premise.holder,
          other: effect.changeId,
        };
  return {
    question: sides.question,
    options: [
      {
        id: PREMISE_HOLDS,
        label: `The premise holds: ${sides.premise}`,
        consequence: `${sides.other} must change so that it no longer contradicts it; ${sides.holder} goes on as declared.`,
      },
      {
        id: EFFECT_STANDS,
        label: `The effect stands: ${sides.effect}`,
        consequence: `${sides.holder} must stop relying on the premise; ${sides.other} goes on as declared.`,
      },
    ],
    about,
    category: reason === "unprovable" ? "unprovable-conflict" : "ambiguous-requirement",
    evidence: evidenceOf(view, note),
    precedents: [],
    default: PREMISE_HOLDS,
  };
}

/** A namespace object's escalations, by id. */
const ESCALATION = "escalation";
/** The decisions its rulings recorded, by id. */
const DECISION = "decision";
/** The one cause an escalation is raised under: a repeated raise is that commit again. */
const RAISE = "raise";

/** What the object that raised an escalation hears of it: the decision its ruling recorded. */
export const ESCALATION_TELLS = ["DecisionRecorded"] as const;

const Row = Schema.Struct({ ...EscalationRecord.fields, raisedBy: Schema.String });
type Row = typeof Row.Type;

const decodeRow = Schema.decodeUnknownSync(Row);
const encodeRow = Schema.encodeSync(Row);
const encodeEscalationEvent = Schema.encodeSync(EscalationEvent);
const encodeRecorded = Schema.encodeSync(DecisionRecorded);
const encodeDecision = Schema.encodeSync(Decision);
const payloadOf = (encoded: unknown): EventDraft["payload"] => JSON.parse(JSON.stringify(encoded));
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

const escalationRef = (id: EscalationId): EntityRef => ({ kind: "escalation", id });
const decisionRef = (id: DecisionId): EntityRef => ({ kind: "decision", id });

const storedRow = (store: Store, id: EscalationId): Row | undefined => {
  const value = store.get(ESCALATION, id);
  return value === undefined ? undefined : decodeRow(value);
};

const recordOf = (row: Row): EscalationRecord => ({
  escalation: row.escalation,
  namespace: row.namespace,
  project: row.project,
  ...(row.sponsor === undefined ? {} : { sponsor: row.sponsor }),
  ...(row.decisionId === undefined ? {} : { decisionId: row.decisionId }),
});

/**
 * Whom an escalation's events concern, beyond the escalation: what it is
 * about, its namespace, and the user asked first. The Projector reads its
 * place and its sponsor here, since the domain's events name neither.
 */
const concerning = (
  row: Pick<Row, "escalation" | "namespace" | "sponsor">,
): readonly EntityRef[] => [
  row.escalation.about,
  { kind: "org", id: row.namespace },
  ...(row.sponsor === undefined ? [] : [{ kind: "user" as const, id: row.sponsor }]),
];

/** An escalation of this namespace, as it stands. */
export const escalationRecord = (
  escalationId: EscalationId,
): Effect.Effect<EscalationRecord, EscalationNotFound, EntityStore> =>
  Effect.gen(function* () {
    const row = storedRow(yield* EntityStore, escalationId);
    return row === undefined
      ? yield* new EscalationNotFound({ escalationId, nextActions: [] })
      : recordOf(row);
  });

/**
 * A namespace object (`ns:<id>`) raises an escalation: EscalationRaised on
 * `escalation:<id>`, in the question's project, with its row and the raiser
 * subscribed to its decision, in one transaction. Once: the id is the
 * caller's, derived from what the question is about, so a raise that comes
 * again (a retry, the other party, a redelivery) finds the escalation there,
 * commits nothing and answers it as first raised, sponsor included.
 */
export const raiseEscalation = Effect.fn("coordination/raiseEscalation")(function* (
  request: RaiseRequest,
) {
  const entity = escalationRef(request.escalationId);
  const raise = (tx: Transaction): Result.Result<Transition<undefined>, InvalidEscalation> => {
    if (storedRow(tx.store, request.escalationId) !== undefined)
      return Result.succeed({ drafts: [], value: undefined });
    const decided = decideEscalation(
      undefined,
      { _tag: "Raise", ...request.ask },
      { now: tx.at, escalationId: request.escalationId },
    );
    if (Result.isFailure(decided)) {
      // A first Raise is refused only as invalid: no escalation is there to be missing, ruled or closed.
      if (decided.failure._tag !== "InvalidEscalation") throw decided.failure;
      return Result.fail(decided.failure);
    }
    let escalation: Escalation | undefined;
    for (const payload of decided.success)
      escalation = evolveEscalation(escalation, { at: tx.at, payload });
    if (escalation === undefined) return Result.succeed({ drafts: [], value: undefined });
    const row: Row = {
      escalation,
      namespace: request.namespace,
      project: request.project,
      ...(request.sponsor === undefined ? {} : { sponsor: request.sponsor }),
      raisedBy: request.raisedBy,
    };
    tx.store.put(ESCALATION, request.escalationId, asStored(encodeRow(row)));
    tx.outbox.subscribe(request.raisedBy, ESCALATION_TELLS, entity);
    return Result.succeed({
      drafts: decided.success.map((payload): EventDraft => ({
        payload: payloadOf(encodeEscalationEvent(payload)),
        affected: concerning(row),
      })),
      value: undefined,
    });
  };
  yield* commit({ entity, cause: RAISE, project: request.project }, raise);
  return yield* Effect.orDie(escalationRecord(request.escalationId));
});

/**
 * A person rules on an escalation of this namespace: RulingGiven, and in the
 * same transaction the decision it makes (DecisionRecorded on
 * `decision:<id>`, its id derived from the escalation's), so no ruling is
 * ever without its decision. The raiser hears the decision and is then
 * released. The machine takes one ruling: a second is EscalationStateRefused,
 * an option the escalation does not offer RulingOptionUnknown. The same
 * Idempotency-Key again answers the escalation as it stands; with another
 * body it is an IdempotencyConflict.
 */
export const giveRuling = Effect.fn("coordination/giveRuling")(function* (command: RulingCommand) {
  const { escalationId } = command;
  const known = yield* escalationRecord(escalationId);
  const entity = escalationRef(escalationId);
  const decisionId = decisionIdOf(escalationId);
  const by = userActor(command.by);
  const rule = (tx: Transaction): Result.Result<Transition<undefined>, RulingRefusal> => {
    const row = storedRow(tx.store, escalationId);
    if (row === undefined)
      return Result.fail(new EscalationNotFound({ escalationId, nextActions: [] }));
    const ruled = decideEscalation(
      row.escalation,
      {
        _tag: "Rule",
        option: command.option,
        by,
        ...(command.rationale === undefined ? {} : { rationale: command.rationale }),
      },
      { now: tx.at, escalationId },
    );
    if (Result.isFailure(ruled)) {
      const refusal = ruled.failure;
      if (refusal._tag === "InvalidEscalation") throw refusal;
      return Result.fail(refusal);
    }
    let escalation = row.escalation;
    for (const payload of ruled.success)
      escalation = evolveEscalation(escalation, { at: tx.at, payload });
    const recorded = decideDecision(
      undefined,
      { _tag: "Record" },
      { now: tx.at, decisionId, escalation },
    );
    // The escalation was ruled a line above, on an option it offers: the domain records it.
    if (Result.isFailure(recorded)) throw recorded.failure;
    const drafts: EventDraft[] = ruled.success.map((payload) => ({
      payload: payloadOf(encodeEscalationEvent(payload)),
      affected: concerning(row),
    }));
    let decision: Decision | undefined;
    for (const payload of recorded.success) {
      if (payload._tag !== "DecisionRecorded") continue;
      decision = evolveDecision(decision, { at: tx.at, payload });
      drafts.push({
        payload: payloadOf(encodeRecorded(payload)),
        entity: decisionRef(decisionId),
        affected: [entity, ...concerning(row)],
      });
    }
    if (decision !== undefined)
      tx.store.put(DECISION, decisionId, asStored(encodeDecision(decision)));
    tx.store.put(ESCALATION, escalationId, asStored(encodeRow({ ...row, escalation, decisionId })));
    return Result.succeed({
      drafts,
      value: undefined,
      after: (after: Transaction) =>
        after.outbox.unsubscribe(row.raisedBy, ESCALATION_TELLS, entity),
    });
  };
  const committed = yield* commit(
    {
      entity,
      cause: `rule:${command.idempotencyKey}`,
      fingerprint: JSON.stringify([command.option, command.by, command.rationale ?? null]),
      project: known.project,
      actor: by,
    },
    rule,
  );
  if (committed.duplicate && !committed.sameCommand)
    return yield* new IdempotencyConflict({ idempotencyKey: command.idempotencyKey });
  return yield* escalationRecord(escalationId);
});
