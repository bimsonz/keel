import { Effect, Option, Schema } from "effect";
import { ChangeRequeued, type RequeueReason } from "../../domain/coordination/index.ts";
import {
  AgentInvited,
  AgentInvitedToProject,
  SponsorRequested,
  AgentLeftNamespace,
  AgentLeftProject,
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
 * position a tool result carried or an inbox read answered. The log is one for
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

/** The cursor that asks for the head: a read from it answers what lands after it, and nothing before. */
export const INBOX_END = "end";

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
 * dense from 1 to the head, and that cursor is a notice's position or the start.
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
const decodeInvitedTo = Schema.decodeUnknownOption(AgentInvitedToProject);
const decodeRequested = Schema.decodeUnknownOption(SponsorRequested);
const decodeLeftProject = Schema.decodeUnknownOption(AgentLeftProject);
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

const decodeSuspected = Schema.decodeUnknownOption(
  Schema.Struct({
    conflictId: Schema.String,
    parties: Schema.Array(Schema.String),
    subjectKey: Schema.optional(Schema.String),
  }),
);

const decodeAnchorSuspicion = Schema.decodeUnknownOption(
  Schema.Struct({
    premise: Schema.Struct({ subject: Schema.String }),
    cause: Schema.Struct({
      changeId: Schema.String,
      anchor: Schema.Struct({ path: Schema.String, symbol: Schema.optional(Schema.String) }),
    }),
  }),
);

const decodePreview = Schema.decodeUnknownOption(
  Schema.Struct({ url: Schema.String, aliasUrl: Schema.optional(Schema.String) }),
);

const decodeRequeued = Schema.decodeUnknownOption(ChangeRequeued);

/**
 * Why a change went back to the front of its lane's queue, and what Keel does
 * with it next, by the requeue's reason. A change that is queued takes no
 * rebase or submit, so nothing here asks for one: after `textual` it runs
 * alone (`runsAlone`), and only its own bounce asks for a rebase.
 */
const REQUEUED: Record<RequeueReason, { readonly because: string; readonly next: string }> = {
  "infra-failure": { because: "its batch failed on Keel's infrastructure", next: "Runs again" },
  bisection: {
    because: "its batch failed and Keel is splitting it to find which change broke it",
    next: "Runs again in a smaller batch",
  },
  invalidated: {
    because: "trunk moved while its batch was verified",
    next: "Verified again on trunk's new head",
  },
  "co-member-failed": {
    because: "another change in its batch failed and was bounced",
    next: "Runs again without that change",
  },
  textual: {
    because: "the changes in its batch could not be merged together",
    next: "Runs alone next; if it does not merge onto trunk on its own, it bounces and asks for a rebase",
  },
  interaction: {
    because: "its batch's changes passed apart but failed together",
    next: "Runs alone next",
  },
  shrink: {
    because: "it passed its checks running fewer tests than trunk's last verdict",
    next: "Waits for a maintainer to accept the drop, then runs again; if they do not, it bounces",
  },
};

/** More than the notice's title says, chosen for the event when it is delivered. */
export function detailOf(event: EventEnvelope): string | undefined {
  switch (event.type) {
    case "ConflictSuspected":
      return Option.match(decodeSuspected(event.payload), {
        onNone: () => undefined,
        onSome: (p) =>
          `Keel suspects a conflict between ${p.parties.join(" and ")}${p.subjectKey === undefined ? "" : ` on ${p.subjectKey}`} and is proving it: nothing is asked of you until it has`,
      });
    case "PremiseSuspected":
      // An effect judged against the premise speaks for itself; an edit of the code it rests on is only a suspicion.
      return Option.match(decodeAnchorSuspicion(event.payload), {
        onNone: () => undefined,
        onSome: ({ premise, cause }) =>
          `${cause.changeId}'s footprint covers ${cause.anchor.path}, ${cause.anchor.symbol === undefined ? "the file" : `where ${cause.anchor.symbol} is anchored: the code`} your premise on ${premise.subject} rests on. This is a suspicion, not a conflict: nothing is held or bounced. Check your premise against that change with why, and revise or rely again if it no longer holds`,
      });
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
    case "ChangeRequeued":
      return Option.match(decodeRequeued(event.payload), {
        onNone: () => undefined,
        onSome: (p) =>
          `Requeued from ${p.batchId}: ${REQUEUED[p.reason].because}. ${REQUEUED[p.reason].next}.`,
      });
    case "PreviewDeployed":
      return Option.match(decodePreview(event.payload), {
        onNone: () => undefined,
        onSome: (p) => `a preview of your change answers at ${p.aliasUrl ?? p.url}`,
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
    case "AgentInvitedToProject":
      return Option.match(decodeInvitedTo(event.payload), {
        onNone: () => undefined,
        onSome: (p) =>
          `you were invited to the project ${p.projectId}: accept, and a token that names it ${givesWork(p.scopes) ? "reads and works" : "reads"} there, and nowhere else in its namespace`,
      });
    case "AgentLeftProject":
      return Option.match(decodeLeftProject(event.payload), {
        onNone: () => undefined,
        onSome: (p) =>
          p.reason === "withdrawn"
            ? `the invitation to the project ${p.projectId} was withdrawn`
            : `you were taken off the project ${p.projectId}: you have no standing there now`,
      });
    case "AgentSponsored":
      return "a person now sponsors you: your questions go to them, and they may pause you";
    case "AgentUnsponsored":
      return "nobody sponsors you now";
    case "AgentSuspended":
      return "your sponsor paused you: until they unpause you, Keel answers only whoami and your inbox";
    case "AgentReinstated":
      return "your sponsor unpaused you: your calls are taken again";
    case "SponsorRequested":
      return Option.match(decodeRequested(event.payload), {
        onNone: () => undefined,
        onSome: (p) =>
          `the agent ${p.agentId} asks the person who sponsors you to sponsor it too: they approve or decline it on their own list of sponsor requests`,
      });
    case "SponsorRequestDeclined":
      return "the person you asked declined to sponsor you";
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
      { kind: "read", title: "Read who you are and who sponsors you", operationId: "whoami" },
    ];
  if (event.type === "AgentSuspended")
    return [
      {
        kind: "call",
        title:
          "Wait in your inbox, with the cursor this answer gave: Keel tells you the moment your sponsor unpauses you",
        operationId: "inbox",
        args: { wait: 600 },
      },
    ];
  if (event.type === "AgentReinstated")
    return [{ kind: "read", title: "Read who you are, then carry on", operationId: "whoami" }];
  if (event.type === "SponsorRequested")
    return Option.match(decodeRequested(event.payload), {
      onNone: () => undefined,
      onSome: (p) => [
        {
          kind: "escalate",
          title: `Tell the person who sponsors you that ${p.agentId} asks them to sponsor it: they approve or decline it on their own list of sponsor requests`,
        },
      ],
    });
  if (event.type === "SponsorRequestDeclined")
    return [
      {
        kind: "call",
        title: "Ask someone else to sponsor you, or ask for a link to show a person",
        operationId: "askSponsor",
      },
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
  if (event.type === "AgentInvitedToProject")
    return Option.match(decodeInvitedTo(event.payload), {
      onNone: () => undefined,
      onSome: (p) => [
        {
          kind: "call",
          title: "Accept the invitation",
          operationId: "Agents_acceptProjectInvitation",
          args: { projectId: p.projectId },
        },
        {
          kind: "call",
          title: "Decline it",
          operationId: "Agents_leaveProject",
          args: { projectId: p.projectId },
        },
      ],
    });
  if (event.type === "AgentLeftProject")
    return [
      {
        kind: "read",
        title: "Read the projects you were invited to",
        operationId: "Agents_listProjects",
      },
    ];
  if (event.type === "ChangeRequeued")
    return Option.match(decodeRequeued(event.payload), {
      onNone: () => undefined,
      onSome: (p) => [
        { kind: "wait", title: REQUEUED[p.reason].next },
        {
          kind: "read",
          title: "Read where the change stands",
          operationId: "status",
          args: { changeId: p.changeId, wait: 30 },
        },
      ],
    });
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

/** Moves the run's `piggybacked` up to `at`, the position of the last notice a read answered: never back. */
function markRead(store: Store, at: string, run: RunId | undefined): void {
  if (at > piggybackedOf(store, run))
    store.put(INBOX.piggybacked.kind, run ?? INBOX.piggybacked.id, at);
}

/**
 * A page of the notices after `cursor` that `run` is shown. An empty page
 * keeps the cursor where it was, and `end` is the head's cursor: a read from
 * it answers nothing that was there before, and a reader holds on from the
 * cursor it gives. In the same transaction the run's `piggybacked` moves up
 * to the last notice the page answers, so a notice the run has read never
 * rides a later tool result of its own. An empty page moves nothing: a cursor
 * the run was never answered (the head's, another run's, one made up) counts
 * no notice as read. A `peek` moves nothing either: it is a watch for what
 * lands, not the run reading it.
 */
export const readInbox: (
  cursor: string | undefined,
  run?: RunId,
  peek?: boolean,
) => Effect.Effect<InboxPage, never, EntityStore> = Effect.fn("identity/readInbox")(function* (
  cursor: string | undefined,
  run?: RunId,
  peek?: boolean,
) {
  const store = yield* EntityStore;
  return store.transaction((): InboxPage => {
    const from = cursor === INBOX_END ? position(headOf(store)) : cursor;
    const entries = entriesAfter(store, from, run);
    const last = entries.at(-1)?.position;
    if (last !== undefined && peek !== true) markRead(store, last, run);
    return {
      notices: entries.map(({ entry, position: at }) => noticeOf(entry, at)),
      cursor: last ?? from ?? START,
    };
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
