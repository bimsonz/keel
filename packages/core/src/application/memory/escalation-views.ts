import { Option, Schema } from "effect";
import {
  type DecisionId,
  type EscalationId,
  type EventEnvelope,
  type Instant,
  NamespaceId,
  UserId,
} from "../../domain/kernel/index.ts";
import { DecisionRecorded } from "../../domain/memory/index.ts";
import { EscalationEvent, evolveEscalation } from "../../domain/verification/index.ts";
import {
  DecisionChosen,
  type EntityStore,
  type EscalationListPage,
  type EscalationListRead,
  type EscalationReader,
  EscalationRecord,
  type LabelledEscalation,
  type Stored,
} from "../ports/index.ts";
import { labelGiven } from "./feed.ts";

/**
 * The Projector's read model of the questions put to people, beside its
 * conflict views: each escalation folded from its own events by the domain's
 * `evolveEscalation`, with the place its raising named (its project, its
 * namespace and the user asked first), and what each ruling decided.
 */
export const ESCALATION_VIEWS = {
  /** The escalation as its events leave it, with its place, by escalation id. */
  escalation: "escalation-view",
  /** Every escalation in the order it was raised, by position: the list reads it newest first. */
  order: "escalation-order",
  head: { kind: "escalation-head", id: "self" },
  /** What a ruling's decision chose, by decision id. */
  decision: "decision-view",
} as const;

export const ESCALATION_PAGE = 50;
export const ESCALATION_PAGE_MAX = 100;

/** How long an escalation waits on the user asked first before the namespace's maintainers are asked too. */
export const MAINTAINERS_AFTER_MS = 30 * 60_000;

type Store = (typeof EntityStore)["Service"];

const decodeRecord = Schema.decodeUnknownSync(EscalationRecord);
const encodeRecord = Schema.encodeSync(EscalationRecord);
const decodeEscalationEvent = Schema.decodeUnknownOption(EscalationEvent);
const decodeRecorded = Schema.decodeUnknownOption(DecisionRecorded);
const decodeChosen = Schema.decodeUnknownSync(DecisionChosen);
const decodeNamespace = Schema.decodeUnknownOption(NamespaceId);
const decodeUser = Schema.decodeUnknownOption(UserId);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

/** Positions sort as strings, as the feed's do. */
const position = (n: number) => String(n).padStart(12, "0");

const ESCALATION_TYPES: ReadonlySet<string> = new Set([
  "EscalationRaised",
  "RulingGiven",
  "EscalationWithdrawn",
  "DecisionRecorded",
]);

/** Whether the escalation view folds this event at all. */
export const foldsEscalation = (event: EventEnvelope): boolean => ESCALATION_TYPES.has(event.type);

/** The record as the fold keeps it: the label is the feed's, joined when it is read. */
function folded(store: Store, escalationId: EscalationId): EscalationRecord | undefined {
  const stored = store.get(ESCALATION_VIEWS.escalation, escalationId);
  return stored === undefined ? undefined : decodeRecord(stored);
}

/**
 * The record with the label the feed gave its raising. The Projector records
 * an arrival on the feed before it folds it, so only a store the feed never
 * numbered answers `E-0`.
 */
const labelled = (store: Store, record: EscalationRecord): LabelledEscalation => ({
  ...record,
  label: labelGiven(store, record.project, "E-", record.escalation.id) ?? "E-0",
});

/** An escalation as the Projector has folded it, with its label; undefined for one it has not heard raised. */
export function escalationView(
  store: Store,
  escalationId: EscalationId,
): LabelledEscalation | undefined {
  const record = folded(store, escalationId);
  return record === undefined ? undefined : labelled(store, record);
}

/** What a decision chose, once the Projector has heard it recorded. */
export function decisionChosen(store: Store, decisionId: DecisionId): DecisionChosen | undefined {
  const stored = store.get(ESCALATION_VIEWS.decision, decisionId);
  return stored === undefined ? undefined : decodeChosen(stored);
}

const headOf = (store: Store): number => {
  const head = store.get(ESCALATION_VIEWS.head.kind, ESCALATION_VIEWS.head.id);
  return typeof head === "number" ? head : 0;
};

/**
 * Folds one arrived event into the escalation view, in the receipt's
 * transaction. The raising names where the escalation belongs: its project on
 * the envelope, and its namespace and the user asked first among the entities
 * it concerns. An event the view cannot take (undecodable, out of the
 * domain's order, of no project or no namespace) leaves it as it was and
 * comes back as a problem for the caller to log.
 */
export function foldEscalationViews(store: Store, event: EventEnvelope): string | undefined {
  if (event.type === "DecisionRecorded") {
    const recorded = decodeRecorded(event.payload);
    if (Option.isNone(recorded)) return `${event.eventId}: an undecodable DecisionRecorded`;
    const { decisionId, escalationId, option, summary } = recorded.value;
    store.put(ESCALATION_VIEWS.decision, decisionId, asStored({ option, summary }));
    const known = folded(store, escalationId);
    if (known === undefined) return `${decisionId} was recorded for ${escalationId}, never heard`;
    store.put(
      ESCALATION_VIEWS.escalation,
      escalationId,
      asStored(encodeRecord({ ...known, decisionId })),
    );
    return undefined;
  }
  const decoded = decodeEscalationEvent(event.payload);
  if (Option.isNone(decoded)) return `${event.eventId}: an undecodable ${event.type}`;
  const payload = decoded.value;
  const before = folded(store, payload.escalationId);
  let escalation: EscalationRecord["escalation"];
  try {
    escalation = evolveEscalation(before?.escalation, { at: event.at, payload });
  } catch (thrown) {
    return `${event.eventId}: ${event.type} out of order for ${payload.escalationId} (${String(thrown)})`;
  }
  if (before !== undefined) {
    store.put(
      ESCALATION_VIEWS.escalation,
      payload.escalationId,
      asStored(encodeRecord({ ...before, escalation })),
    );
    return undefined;
  }
  const namespace = Option.getOrUndefined(
    decodeNamespace(event.affected.find((ref) => ref.kind === "org")?.id),
  );
  if (event.project === undefined || namespace === undefined)
    return `${payload.escalationId} was raised with no project or no namespace`;
  const sponsor = Option.getOrUndefined(
    decodeUser(event.affected.find((ref) => ref.kind === "user")?.id),
  );
  store.put(
    ESCALATION_VIEWS.escalation,
    payload.escalationId,
    asStored(
      encodeRecord({
        escalation,
        namespace,
        project: event.project,
        ...(sponsor === undefined ? {} : { sponsor }),
      }),
    ),
  );
  const next = headOf(store) + 1;
  store.put(ESCALATION_VIEWS.order, position(next), payload.escalationId);
  store.put(ESCALATION_VIEWS.head.kind, ESCALATION_VIEWS.head.id, next);
  return undefined;
}

/**
 * Whether an escalation is in a reader's list.
 *
 * An agent reads every escalation of its own project.
 *
 * A person's list is their inbox, and its rule is who is asked when: the user
 * asked first (the sponsor of the agent concerned) sees the escalation from
 * the moment it is raised; the maintainers of its namespace see it once
 * thirty minutes have passed without an answer, or at once when it names
 * nobody to ask first. It is a rule of the read, by the reader's clock: no
 * timer fires, and nothing is reassigned. In a person's own namespace the
 * maintainers are its owner alone, so the wider turn reaches nobody new.
 */
export function listedTo(
  record: EscalationRecord,
  reader: EscalationReader,
  now: Instant,
): boolean {
  if (reader._tag === "Project") return record.project === reader.project;
  if (record.sponsor === reader.userId) return true;
  return (
    reader.maintains.includes(record.namespace) &&
    (record.sponsor === undefined || now - record.escalation.raisedAt >= MAINTAINERS_AFTER_MS)
  );
}

/**
 * A reader's escalations, newest first: those `listedTo` it, in the state
 * asked for, a page at a time. The cursor is the position of the last one
 * read, so an escalation raised between two pages is never skipped or
 * repeated.
 */
export function listEscalations(store: Store, read: EscalationListRead): EscalationListPage {
  const limit = Math.min(Math.max(read.limit ?? ESCALATION_PAGE, 1), ESCALATION_PAGE_MAX);
  const from = read.cursor === undefined ? headOf(store) : Number(read.cursor) - 1;
  const items: LabelledEscalation[] = [];
  let at = Number.isFinite(from) ? from : 0;
  for (; at >= 1 && items.length < limit; at -= 1) {
    const id = store.get(ESCALATION_VIEWS.order, position(at));
    const stored = typeof id === "string" ? store.get(ESCALATION_VIEWS.escalation, id) : undefined;
    if (stored === undefined) continue;
    const record = decodeRecord(stored);
    if (read.state !== undefined && record.escalation.state !== read.state) continue;
    if (listedTo(record, read.reader, read.now)) items.push(labelled(store, record));
  }
  // `at` is one below the last position read; more may be listed beneath it.
  return at >= 1 ? { items, nextCursor: position(at + 1) } : { items };
}
