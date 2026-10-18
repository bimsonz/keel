import { Effect, Result, Schema } from "effect";
import { IdempotencyConflict } from "../../domain/identity/index.ts";
import {
  closingNumbers,
  type CloseReason,
  type CommentText,
  decideIssue,
  evolveIssue,
  Issue,
  IssueComment,
  type IssueCommand,
  type IssueFacts,
  IssueNotFound,
  IssueNumber,
  IssuesEvent,
  type IssueText,
  type IssueTitle,
} from "../../domain/issues/index.ts";
import {
  type ChangeId,
  type CommandActor,
  type EntityRef,
  IllegalTransition,
  IssueId,
  type ProjectId,
} from "../../domain/kernel/index.ts";
import {
  commit,
  EntityStore,
  type EventDraft,
  Ids,
  type IssuePage,
  IssueNumbers,
  type IssueQuery,
  type IssueThread,
  type Stored,
  type Transaction,
} from "../ports/index.ts";

/** The store kinds of a project's issues, in the project's own object. */
export const ISSUES = {
  /** `<issueId>` → the issue. */
  issue: "issue",
  /** `<#n, padded>` → the issue's id, so issues list newest first by number. */
  byNumber: "issue-number",
  /** `<issueId>/<n, padded>` → each comment, oldest first. */
  comment: "issue-comment",
  /** An opening's commit cause → the id and `#n` it was given, so a retry asks for no second number. */
  opened: "issue-opened",
  /** `open` and `closed` → how many the project has. */
  count: "issue-count",
} as const;

/** The most comments one read of an issue answers with. */
export const COMMENTS_SHOWN = 500;

const decodeIssue = Schema.decodeUnknownSync(Issue);
const encodeIssue = Schema.encodeSync(Issue);
const decodeComment = Schema.decodeUnknownSync(IssueComment);
const encodeComment = Schema.encodeSync(IssueComment);
const encodeEvent = Schema.encodeSync(IssuesEvent);
const Opened = Schema.Struct({ issueId: IssueId, number: IssueNumber });
const decodeOpened = Schema.decodeUnknownSync(Opened);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));
const padded = (n: number) => String(n).padStart(12, "0");

type Store = (typeof EntityStore)["Service"];

const issueOf = (store: Store, issueId: IssueId): Issue | undefined => {
  const stored = store.get(ISSUES.issue, issueId);
  return stored === undefined ? undefined : decodeIssue(stored);
};

const idOfNumber = (store: Store, number: number): IssueId | undefined => {
  const stored = store.get(ISSUES.byNumber, padded(number));
  return typeof stored === "string" ? Schema.decodeUnknownSync(IssueId)(stored) : undefined;
};

/** The project's issue of that `#n`, or undefined. */
export const issueNumbered = (store: Store, number: number): Issue | undefined => {
  const issueId = idOfNumber(store, number);
  return issueId === undefined ? undefined : issueOf(store, issueId);
};

const countOf = (store: Store, state: "open" | "closed"): number => {
  const held = store.get(ISSUES.count, state);
  return typeof held === "number" ? held : 0;
};

/** Who an issue's event concerns beyond its project: whoever wrote what it is about. */
const concerning = (actor: CommandActor): readonly EntityRef[] => {
  const [kind, id] = actor.split(":");
  return kind === "agent" || kind === "user" ? [{ kind, id: id ?? "" }] : [];
};

/**
 * Decides one command on one issue, folds what it decided into the record and
 * keeps the record, its number row, its comment and the counts, inside the
 * transaction that commits the events. Answers the record and the drafts.
 */
function apply(
  tx: Pick<Transaction, "store" | "at">,
  issue: Issue | undefined,
  command: IssueCommand,
  facts: IssueFacts,
  writtenBy: CommandActor | undefined,
): { readonly issue: Issue; readonly drafts: readonly EventDraft[] } {
  const { store, at } = tx;
  let state = issue;
  const drafts: EventDraft[] = [];
  for (const payload of decideIssue(issue, command, facts)) {
    const before = state?.state;
    state = evolveIssue(state, { at, payload });
    drafts.push({
      payload: JSON.parse(JSON.stringify(encodeEvent(payload))),
      affected: writtenBy === undefined ? concerning(state.author) : concerning(writtenBy),
    });
    if (payload._tag === "IssueCommented")
      store.put(
        ISSUES.comment,
        `${payload.issueId}/${padded(state.comments)}`,
        asStored(
          encodeComment({
            commentId: payload.commentId,
            issueId: payload.issueId,
            author: payload.author,
            body: payload.body,
            at,
          }),
        ),
      );
    if (before !== state.state) {
      if (before !== undefined) store.put(ISSUES.count, before, countOf(store, before) - 1);
      store.put(ISSUES.count, state.state, countOf(store, state.state) + 1);
    }
  }
  if (state === undefined)
    throw new IllegalTransition(`${command._tag} left ${facts.issueId} unopened`);
  store.put(ISSUES.issue, state.issueId, asStored(encodeIssue(state)));
  store.put(ISSUES.byNumber, padded(state.number), state.issueId);
  return { issue: state, drafts };
}

/** An opening, as the project's object is sent it: `fingerprint` hashes the request, so a reused key is told apart from a retry. */
export interface OpenIssue {
  readonly title: IssueTitle;
  readonly body: IssueText;
  readonly author: CommandActor;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

/**
 * Opens an issue on the project with its next `#n`, idempotent by the
 * author's key. A retry finds the id and number its first try was given
 * before it asks for any, so a number is given once.
 */
export const openIssue = Effect.fn("issues/openIssue")(function* (
  projectId: ProjectId,
  command: OpenIssue,
) {
  const store = yield* EntityStore;
  const cause = `open-issue:${command.author}:${command.idempotencyKey}`;
  const held = store.get(ISSUES.opened, cause);
  const { issueId, number } =
    held === undefined
      ? yield* Effect.gen(function* () {
          const minted = yield* (yield* Ids).next("iss");
          return { issueId: minted, number: yield* (yield* IssueNumbers).give(projectId, minted) };
        })
      : decodeOpened(held);
  const facts: IssueFacts = { projectId, issueId, number };
  const committed = yield* commit(
    {
      entity: { kind: "project", id: projectId },
      cause,
      fingerprint: command.fingerprint,
      actor: command.author,
      project: projectId,
    },
    (tx) => {
      const opened = apply(
        tx,
        issueOf(tx.store, issueId),
        { _tag: "Open", title: command.title, body: command.body, author: command.author },
        facts,
        undefined,
      );
      tx.store.put(ISSUES.opened, cause, asStored({ issueId, number }));
      return Result.succeed({ value: opened.issue, drafts: opened.drafts });
    },
  );
  if (committed.duplicate && !committed.sameCommand)
    return yield* new IdempotencyConflict({ idempotencyKey: command.idempotencyKey });
  if (!committed.duplicate) return committed.value;
  const opened = issueOf(store, issueId);
  if (opened === undefined) throw new IllegalTransition(`${cause} committed and left no issue`);
  return opened;
});

/** A command on an issue by its `#n`, as the project's object is sent it. */
export type IssueMove =
  | { readonly _tag: "Comment"; readonly body: CommentText }
  | { readonly _tag: "Close"; readonly reason: CloseReason }
  | { readonly _tag: "Reopen" };

export interface MoveIssue {
  readonly number: IssueNumber;
  readonly move: IssueMove;
  readonly by: CommandActor;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

/**
 * Comments on, closes or reopens the project's issue `#n`, idempotent by the
 * caller's key. Answers the issue as it stands after, and the comment a
 * comment made. One the project has not got is `IssueNotFound`.
 */
export const moveIssue = Effect.fn("issues/moveIssue")(function* (
  projectId: ProjectId,
  command: MoveIssue,
) {
  const store = yield* EntityStore;
  const issueId = idOfNumber(store, command.number);
  if (issueId === undefined) return yield* new IssueNotFound({ projectId, number: command.number });
  const facts: IssueFacts = { projectId, issueId, number: command.number };
  const cause = `${command.move._tag.toLowerCase()}-issue:${command.number}:${command.by}:${command.idempotencyKey}`;
  const decided: IssueCommand =
    command.move._tag === "Comment"
      ? {
          _tag: "Comment",
          commentId: yield* (yield* Ids).next("cmt"),
          body: command.move.body,
          author: command.by,
        }
      : command.move._tag === "Close"
        ? { _tag: "Close", reason: command.move.reason, by: command.by }
        : { _tag: "Reopen", by: command.by };
  const committed = yield* commit(
    {
      entity: { kind: "project", id: projectId },
      cause,
      fingerprint: command.fingerprint,
      actor: command.by,
      project: projectId,
    },
    (tx) => {
      const moved = apply(tx, issueOf(tx.store, issueId), decided, facts, command.by);
      return Result.succeed({ value: moved.issue, drafts: moved.drafts });
    },
  );
  if (committed.duplicate && !committed.sameCommand)
    return yield* new IdempotencyConflict({ idempotencyKey: command.idempotencyKey });
  const issue = issueOf(store, issueId);
  if (issue === undefined) throw new IllegalTransition(`${cause} committed and left no issue`);
  const commented = committed.events
    .map((event) => Schema.decodeUnknownOption(IssuesEvent)(event.payload))
    .flatMap((decoded) => (decoded._tag === "Some" ? [decoded.value] : []))
    .find((event) => event._tag === "IssueCommented");
  const comment =
    commented === undefined
      ? undefined
      : commentsOf(store, issueId).find((c) => c.commentId === commented.commentId);
  return { issue, comment };
});

/**
 * Closes, as `completed`, each open issue of the project that a landed
 * change's goal names with a closing keyword ("Fixes #12"), inside the
 * transaction that heard the landing, and answers the drafts. A number the
 * project has no issue of, a change's own `#n` and an issue closed already
 * close nothing.
 */
export function closeIssuesNamed(
  tx: Pick<Transaction, "store" | "at">,
  projectId: ProjectId,
  changeId: ChangeId,
  goal: string,
): readonly EventDraft[] {
  return closingNumbers(goal).flatMap((number) => {
    const issueId = idOfNumber(tx.store, number);
    if (issueId === undefined) return [];
    const issue = issueOf(tx.store, issueId);
    if (issue === undefined || issue.state !== "open") return [];
    return apply(
      tx,
      issue,
      { _tag: "CloseByChange", changeId },
      { projectId, issueId, number },
      undefined,
    ).drafts;
  });
}

const commentsOf = (store: Store, issueId: IssueId): readonly IssueComment[] =>
  store
    .list(ISSUES.comment, `${issueId}/`)
    .slice(0, COMMENTS_SHOWN)
    .map(({ value }) => decodeComment(value));

/** The project's issue `#n` and its first comments, oldest first; one it has not got is `IssueNotFound`. */
export function issueThread(
  store: Store,
  projectId: ProjectId,
  number: IssueNumber,
): Result.Result<IssueThread, IssueNotFound> {
  const issue = issueNumbered(store, number);
  return issue === undefined
    ? Result.fail(new IssueNotFound({ projectId, number }))
    : Result.succeed({ issue, comments: commentsOf(store, issue.issueId) });
}

/**
 * A page of the project's issues, newest first, in one state or both, below
 * `before` when the query gives one. `next` reads the page after.
 */
export function issuePage(store: Store, query: Omit<IssueQuery, "projectId">): IssuePage {
  const rows = store.list(ISSUES.byNumber).toReversed();
  const items: Issue[] = [];
  let next: number | undefined;
  for (const { id, value } of rows) {
    const number = Number(id);
    if (query.before !== undefined && number >= query.before) continue;
    if (typeof value !== "string") continue;
    const issue = issueOf(store, Schema.decodeUnknownSync(IssueId)(value));
    if (issue === undefined || (query.state !== undefined && issue.state !== query.state)) continue;
    if (items.length === query.limit) {
      next = items.at(-1)?.number;
      break;
    }
    items.push(issue);
  }
  return {
    items,
    ...(next === undefined ? {} : { next }),
    open: countOf(store, "open"),
    closed: countOf(store, "closed"),
  };
}
