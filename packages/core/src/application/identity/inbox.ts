import { Effect, Option, Schema } from "effect";
import {
  AgentInvited,
  AgentLeftNamespace,
  type AgentNotice,
  givesWork,
  type InboxEntry,
  InboxEntry as InboxEntrySchema,
  type InboxPage,
  noticeOf,
  shownTo,
} from "../../domain/identity/index.ts";
import { type EventEnvelope, NextAction, type RunId } from "../../domain/kernel/index.ts";
import { EntityStore, type Stored } from "../ports/index.ts";

/**
 * Where an agent's inbox lives in its AgentSession DO's store: one entry per
 * delivered event, by position, and the `piggybacked` cursor: the last
 * position a tool result carried or an inbox read returned. The log is one for
 * all the agent's runs; each run keeps a `piggybacked` cursor of its own, under
 * its run id, and a reader with no run keeps the one under `self`.
 */
export const INBOX = {
  kind: "inbox",
  head: { kind: "inbox-head", id: "self" },
  piggybacked: { kind: "inbox-piggybacked", id: "self" },
} as const;

/** The most notices one inbox read answers with. */
export const INBOX_PAGE = 50;

/** The most notices one tool result carries: the agent envelope's `notices`. */
export const PIGGYBACK_MAX = 3;

/** Positions sort as strings; the cursor is the last position read. */
const position = (n: number) => String(n).padStart(12, "0");
const START = position(0);
const POSITION = /^\d{12}$/;

type Store = (typeof EntityStore)["Service"];

/** An entry as the store keeps it: its optional fields are left out, never stored as undefined. */
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));

const headOf = (store: Store): number => {
  const head = store.get(INBOX.head.kind, INBOX.head.id);
  return typeof head === "number" ? head : 0;
};

const piggybackedOf = (store: Store, run: RunId | undefined): string => {
  const at = store.get(INBOX.piggybacked.kind, run ?? INBOX.piggybacked.id);
  return typeof at === "string" ? at : START;
};

/**
 * How many notices wait unread for a run: the positions after its
 * `piggybacked` cursor, less the entries there it is not shown. Positions are
 * dense from 1 to the head, and reads clamp the cursor to it.
 */
export const inboxDepth = (store: Store, run?: RunId): number => {
  const read = piggybackedOf(store, run);
  const hidden = store
    .list(INBOX.kind)
    .filter(
      (row) =>
        row.id > read && !shownTo(Schema.decodeUnknownSync(InboxEntrySchema)(row.value), run),
    ).length;
  return headOf(store) - Number(read) - hidden;
};

/** The next actions an event's payload names, when it names any. */
const decodeInvited = Schema.decodeUnknownOption(AgentInvited);
const decodeLeft = Schema.decodeUnknownOption(AgentLeftNamespace);
const decodeActionable = Schema.decodeUnknownOption(
  Schema.Struct({ nextActions: Schema.optional(Schema.Array(NextAction)) }),
);
const decodeNoted = Schema.decodeUnknownOption(
  Schema.Struct({ evidenceRef: Schema.optional(Schema.String) }),
);
const decodeSameIntent = Schema.decodeUnknownOption(
  Schema.Struct({ changeId: Schema.String, alternativeId: Schema.String }),
);
const decodeLandedSameIntent = Schema.decodeUnknownOption(
  Schema.Struct({ changeId: Schema.String, landedChangeId: Schema.String }),
);
const decodeEscalation = Schema.decodeUnknownOption(
  Schema.Struct({
    conflictId: Schema.optional(Schema.String),
    escalationId: Schema.optional(Schema.String),
    decisionId: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  }),
);

/** More than the notice's title says, chosen for the event when it is delivered. */
export function detailOf(event: EventEnvelope): string | undefined {
  switch (event.type) {
    case "ConflictNoted":
      return Option.getOrUndefined(decodeNoted(event.payload))?.evidenceRef;
    case "AlternativeDeclared":
      return Option.match(decodeSameIntent(event.payload), {
        onNone: () => undefined,
        onSome: (p) =>
          `${p.alternativeId} was declared with the same intent as your change ${p.changeId}`,
      });
    case "AlternativeLanded":
      return Option.match(decodeLandedSameIntent(event.payload), {
        onNone: () => undefined,
        onSome: (p) =>
          `${p.landedChangeId}, with the same intent as your change ${p.changeId}, landed`,
      });
    case "ConflictEscalated":
      return Option.match(decodeEscalation(event.payload), {
        onNone: () => undefined,
        onSome: (p) =>
          `${p.conflictId} was put to a person as ${p.escalationId}${p.reason === "unprovable" ? ": Keel could not prove it either way" : ""}`,
      });
    case "ConflictResolved":
    case "ChangeResumed":
      return Option.match(decodeEscalation(event.payload), {
        onNone: () => undefined,
        onSome: (p) => (p.decisionId === undefined ? undefined : `decided by ${p.decisionId}`),
      });
    case "ChangeBounced":
      return Option.match(decodeEscalation(event.payload), {
        onNone: () => undefined,
        onSome: (p) =>
          p.decisionId === undefined ? undefined : `ruled against by ${p.decisionId}`,
      });
    case "ChangeParked":
      return Option.match(decodeEscalation(event.payload), {
        onNone: () => undefined,
        onSome: (p) =>
          p.escalationId === undefined ? undefined : `waiting for a ruling on ${p.escalationId}`,
      });
    case "AgentInvited":
      return Option.match(decodeInvited(event.payload), {
        onNone: () => undefined,
        onSome: (p) =>
          `a member invited you into ${p.namespace}: accept, and a token that names one of its projects ${givesWork(p.scopes) ? "reads and works" : "reads"} there`,
      });
    case "AgentLeftNamespace":
      return Option.match(decodeLeft(event.payload), {
        onNone: () => undefined,
        onSome: (p) =>
          p.reason === "withdrawn"
            ? `the invitation into ${p.namespace} was withdrawn`
            : `you were taken out of ${p.namespace}: you have no standing there now`,
      });
    case "AgentSponsored":
      return "a person now stands behind you: your questions go to them, and they may pause you";
    case "AgentUnsponsored":
      return "nobody stands behind you now";
    default:
      return undefined;
  }
}

const readConflict = (conflictId: string, title: string): NextAction => ({
  kind: "read",
  title,
  operationId: "Conflicts_getConflict",
  args: { conflictId },
});

/**
 * What an agent can do about a delivered event: the next actions its payload
 * names, and for a conflict put to a person or ruled on, where to read the
 * question and the decision.
 */
export function actionsOf(event: EventEnvelope): readonly NextAction[] | undefined {
  const named = Option.getOrUndefined(decodeActionable(event.payload))?.nextActions;
  if (named !== undefined) return named;
  if (event.type === "AgentSponsored" || event.type === "AgentUnsponsored")
    return [
      { kind: "read", title: "Read who you are and who stands behind you", operationId: "whoami" },
    ];
  if (event.type === "AgentInvited")
    return Option.match(decodeInvited(event.payload), {
      onNone: () => undefined,
      onSome: (p) => [
        {
          kind: "call",
          title: "Accept the invitation",
          operationId: "Agents_acceptInvitation",
          args: { namespace: p.namespace },
        },
        {
          kind: "call",
          title: "Decline it",
          operationId: "Agents_leaveNamespace",
          args: { namespace: p.namespace },
        },
      ],
    });
  if (event.type === "AgentLeftNamespace")
    return [
      {
        kind: "read",
        title: "Read the namespaces you stand in",
        operationId: "Agents_listNamespaces",
      },
    ];
  const conflictId = Option.getOrUndefined(decodeEscalation(event.payload))?.conflictId;
  if (conflictId === undefined) return undefined;
  switch (event.type) {
    case "ConflictEscalated":
      return [
        readConflict(conflictId, "Read the question a person was asked, and wait for the ruling"),
      ];
    case "ConflictResolved":
      return [
        readConflict(conflictId, "Read the decision, and act on what it means for your change"),
      ];
    default:
      return undefined;
  }
}

/**
 * Records a delivered event as the inbox's next entry, with its detail and
 * the next actions its payload names, the run that caused it and the run it is
 * for (`holder`: none when it is for every run). Synchronous: it runs inside
 * the reaction's transaction.
 */
export function recordDelivery(store: Store, event: EventEnvelope, holder?: RunId): void {
  const next = headOf(store) + 1;
  const detail = detailOf(event);
  const nextActions = actionsOf(event);
  const entry: typeof InboxEntrySchema.Encoded = {
    eventId: event.eventId,
    type: event.type,
    entity: event.entity,
    seq: event.seq,
    at: event.at,
    ...(detail === undefined ? {} : { detail }),
    ...(nextActions === undefined
      ? {}
      : { nextActions: nextActions.map((action) => Schema.encodeSync(NextAction)(action)) }),
    ...(event.run === undefined ? {} : { by: event.run.id }),
    ...(holder === undefined ? {} : { for: holder }),
  };
  store.put(INBOX.kind, position(next), asStored(entry));
  store.put(INBOX.head.kind, INBOX.head.id, next);
}

/** The entries after `cursor` that `run` is shown (`shownTo`), oldest first, at most `limit`. */
export function entriesAfter(
  store: Store,
  cursor: string | undefined,
  run?: RunId,
  limit = INBOX_PAGE,
): readonly { readonly position: string; readonly entry: InboxEntry }[] {
  const from = cursor ?? START;
  return store
    .list(INBOX.kind)
    .filter((row) => row.id > from)
    .toSorted((a, b) => (a.id < b.id ? -1 : 1))
    .map((row) => ({
      position: row.id,
      entry: Schema.decodeUnknownSync(InboxEntrySchema)(row.value),
    }))
    .filter(({ entry }) => shownTo(entry, run))
    .slice(0, limit);
}

/**
 * Moves the run's `piggybacked` up to `cursor`: never back, and never past the
 * newest entry, so a cursor the agent made up cannot silence notices still to come.
 */
function markRead(store: Store, cursor: string, run: RunId | undefined): void {
  if (!POSITION.test(cursor)) return;
  const head = position(headOf(store));
  const read = cursor > head ? head : cursor;
  if (read > piggybackedOf(store, run))
    store.put(INBOX.piggybacked.kind, run ?? INBOX.piggybacked.id, read);
}

/**
 * A page of the notices after `cursor` that `run` is shown. An empty page
 * keeps the cursor where it was. In the same transaction the run's
 * `piggybacked` moves up to the page's cursor, so a notice the run has read
 * never rides a later tool result of its own.
 */
export const readInbox: (
  cursor: string | undefined,
  run?: RunId,
) => Effect.Effect<InboxPage, never, EntityStore> = Effect.fn("identity/readInbox")(function* (
  cursor: string | undefined,
  run?: RunId,
) {
  const store = yield* EntityStore;
  return store.transaction((): InboxPage => {
    const entries = entriesAfter(store, cursor, run);
    const page = {
      notices: entries.map(({ entry, position: at }) => noticeOf(entry, at)),
      cursor: entries.at(-1)?.position ?? cursor ?? START,
    };
    markRead(store, page.cursor, run);
    return page;
  });
});

/**
 * The piggyback: up to `limit` (at most 3) notices `run` is shown that no tool
 * result of its own has carried and no inbox read of its own has returned,
 * oldest first. Taking them moves the run's `piggybacked` past them in the
 * same transaction, so each rides at most one of its tool results, and one
 * run's taking leaves every other run's notices where they were; the inbox
 * still holds every one.
 */
export const takeNotices: (
  limit: number,
  run?: RunId,
) => Effect.Effect<readonly AgentNotice[], never, EntityStore> = Effect.fn("identity/takeNotices")(
  function* (limit: number, run?: RunId) {
    const store = yield* EntityStore;
    return store.transaction((): readonly AgentNotice[] => {
      const entries = entriesAfter(
        store,
        piggybackedOf(store, run),
        run,
        Math.min(Math.max(limit, 0), PIGGYBACK_MAX),
      );
      const last = entries.at(-1);
      if (last !== undefined)
        store.put(INBOX.piggybacked.kind, run ?? INBOX.piggybacked.id, last.position);
      return entries.map(({ entry, position: at }) => noticeOf(entry, at));
    });
  },
);
