import { Effect } from "effect";
import type {
  Change,
  ChangeNotFound,
  ChangeStateRefused,
  CommitNotInWorkspace,
  LeaseStale,
  PoolExhausted,
  SketchNotFound,
} from "../../domain/coordination/index.ts";
import type { IdempotencyConflict, InboxPage, Principal } from "../../domain/identity/index.ts";
import type { ChangeId } from "../../domain/kernel/index.ts";
import {
  Changes,
  EventFeed,
  type EventFeedPage,
  Inbox,
  type SubmissionStatus,
} from "../ports/index.ts";
import type { Declared, DeclareInput, SubmitInput } from "./index.ts";

/**
 * The isolate's side of the work loop. The doorways have already checked the
 * caller's scope; each use-case hands the call to the Change or AgentSession DO
 * that decides it. Leases are authorised there and only there.
 */

/** The longest a read may wait, in seconds (the spec's `?wait`). */
export const MAX_WAIT_SECONDS = 30;

const clampWait = (seconds: number | undefined) =>
  Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.trunc(seconds ?? 0)));

export const declareChange: (
  principal: Principal,
  input: DeclareInput,
) => Effect.Effect<Declared, PoolExhausted | SketchNotFound | IdempotencyConflict, Changes> = (
  principal,
  input,
) => Changes.use((changes) => changes.declare(principal, input));

export const submitChange: (
  principal: Principal,
  input: SubmitInput,
) => Effect.Effect<
  Change,
  ChangeNotFound | LeaseStale | ChangeStateRefused | CommitNotInWorkspace | IdempotencyConflict,
  Changes
> = (principal, input) => Changes.use((changes) => changes.submit(principal, input));

/** Where a change's submission stands, waiting up to `waitSeconds` (0–30) for it to move. */
export const submissionOf: (
  changeId: ChangeId,
  waitSeconds?: number,
) => Effect.Effect<SubmissionStatus, ChangeNotFound, Changes> = (changeId, waitSeconds) =>
  Changes.use((changes) => changes.awaitSubmission(changeId, clampWait(waitSeconds)));

/** The caller's own inbox after `cursor`, waiting up to `waitSeconds` (0–30) for a notice. */
export const readInbox: (
  principal: Principal,
  cursor: string | undefined,
  waitSeconds?: number,
) => Effect.Effect<InboxPage, never, Inbox> = (principal, cursor, waitSeconds) =>
  Inbox.use((inbox) => inbox.read(principal.agentId, cursor, clampWait(waitSeconds)));

/**
 * Who reads the whole feed at L1: an observer, because Mission Control shows
 * every project (S-0's control project too), and an operator, whose authority
 * is instance-wide. Anyone else reads only the events of its own project.
 */
const readsInstanceWide = (principal: Principal): boolean =>
  principal.scopes.includes("observer") || principal.scopes.includes("operator");

/**
 * The event feed after `cursor`, waiting up to `waitSeconds` (0–30) for an
 * event. An agent's page keeps only its project's events, so it may hold fewer
 * than `limit`, or none, while its cursor still moves past the rest.
 */
export const readEvents: (
  principal: Principal,
  input: { readonly cursor?: string; readonly limit?: number; readonly waitSeconds?: number },
) => Effect.Effect<EventFeedPage, never, EventFeed> = (principal, input) =>
  EventFeed.use((feed) =>
    feed.read({
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      waitSeconds: clampWait(input.waitSeconds),
    }),
  ).pipe(
    Effect.map((page) =>
      readsInstanceWide(principal)
        ? page
        : { ...page, events: page.events.filter((e) => e.project === principal.projectId) },
    ),
  );
