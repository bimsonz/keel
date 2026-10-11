import { Effect } from "effect";
import type {
  Change,
  ChangeInOtherProject,
  ChangeNotFound,
  ChangeStateRefused,
  CommitNotInWorkspace,
  LeaseNotLapsed,
  LeaseStale,
  PoolExhausted,
  SketchNotFound,
} from "../../domain/coordination/index.ts";
import type { IdempotencyConflict, InboxPage, Principal } from "../../domain/identity/index.ts";
import type { ChangeId, ProjectId } from "../../domain/kernel/index.ts";
import {
  type ChangeListPage,
  type ChangeListRead,
  Changes,
  EventFeed,
  type EventFeedPage,
  Inbox,
  ProjectViews,
  type SubmissionStatus,
  type ViewSnapshot,
} from "../ports/index.ts";
import type { Adopted, AdoptInput, Declared, DeclareInput, SubmitInput } from "./index.ts";

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

/** Takes over a change whose lease lapsed. The Change DO checks the lapse and the caller's project. */
export const adoptChange: (
  principal: Principal,
  input: AdoptInput,
) => Effect.Effect<
  Adopted,
  ChangeNotFound | ChangeStateRefused | LeaseNotLapsed | ChangeInOtherProject | IdempotencyConflict,
  Changes
> = (principal, input) => Changes.use((changes) => changes.adopt(principal, input));

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

/**
 * The project a read of a project's views is about: the one asked for, or the
 * token's when none is. An agent reads its own project only, so asking for
 * another, whether or not it exists, is undefined (a 403); an observer or an
 * operator reads any.
 */
export const viewedProject = (principal: Principal, asked?: ProjectId): ProjectId | undefined => {
  if (asked === undefined || asked === principal.projectId) return principal.projectId;
  return readsInstanceWide(principal) ? asked : undefined;
};

/** A project's changes from the Projector's read model, newest `#n` first. */
export const readChangeList: (
  read: ChangeListRead,
) => Effect.Effect<ChangeListPage, never, ProjectViews> = (read) =>
  ProjectViews.use((views) => views.changes(read));

/** A project's changes and trunk at the feed's head, with the cursor to fold forward from. */
export const readSnapshot: (
  project: ProjectId,
) => Effect.Effect<ViewSnapshot, never, ProjectViews> = (project) =>
  ProjectViews.use((views) => views.snapshot(project));
