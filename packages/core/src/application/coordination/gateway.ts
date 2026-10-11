import { Effect, Schema } from "effect";
import {
  type Change,
  type ChangeInOtherProject,
  ChangeNotFound,
  type ChangeStateRefused,
  type CommitNotInWorkspace,
  type LeaseNotLapsed,
  type LeaseStale,
  type PoolExhausted,
  type Preflight,
  type RevisionMismatch,
  type SketchNotFound,
  type WithdrawAuthority,
} from "../../domain/coordination/index.ts";
import type { IdempotencyConflict, InboxPage, AgentToken } from "../../domain/identity/index.ts";
import { ChangeId, type LeaseId, type ProjectId } from "../../domain/kernel/index.ts";
import {
  type ChangeListPage,
  type ChangeListRead,
  type ChangeRead,
  Changes,
  EventFeed,
  type EventFeedPage,
  Inbox,
  type Projects,
  ProjectViews,
  type SubmissionStatus,
  type ViewSnapshot,
} from "../ports/index.ts";
import type { PushRejected } from "../../domain/integration/index.ts";
import type { PackTooLarge } from "../ports/index.ts";
import type { RebasedChange } from "./change.ts";
import type {
  AbandonCall,
  Adopted,
  AdoptInput,
  Declared,
  DeclareInput,
  RebaseInput,
  RelyInput,
  ReviseInput,
  Revised,
  SubmitInput,
} from "./index.ts";
import { audienceOf, projectScope, type ReadRefused, readScope, viewScope } from "./read-scope.ts";

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
  principal: AgentToken,
  input: DeclareInput,
) => Effect.Effect<Declared, PoolExhausted | SketchNotFound | IdempotencyConflict, Changes> = (
  principal,
  input,
) => Changes.use((changes) => changes.declare(principal, input));

export const submitChange: (
  principal: AgentToken,
  input: SubmitInput,
) => Effect.Effect<
  Change,
  ChangeNotFound | LeaseStale | ChangeStateRefused | CommitNotInWorkspace | IdempotencyConflict,
  Changes
> = (principal, input) => Changes.use((changes) => changes.submit(principal, input));

/** Takes over a change whose lease lapsed. The Change DO checks the lapse and the caller's project. */
export const adoptChange: (
  principal: AgentToken,
  input: AdoptInput,
) => Effect.Effect<
  Adopted,
  ChangeNotFound | ChangeStateRefused | LeaseNotLapsed | ChangeInOtherProject | IdempotencyConflict,
  Changes
> = (principal, input) => Changes.use((changes) => changes.adopt(principal, input));

/** Moves a change onto trunk's head after a textual bounce. The Change DO checks the lease and the state before anything is pushed. */
export const rebaseChange: (
  principal: AgentToken,
  input: RebaseInput,
) => Effect.Effect<
  RebasedChange,
  | ChangeNotFound
  | LeaseStale
  | ChangeStateRefused
  | IdempotencyConflict
  | PushRejected
  | PackTooLarge,
  Changes
> = (principal, input) => Changes.use((changes) => changes.rebase(principal, input));

/** Revises a change's intent at the revision the caller last read. The Change DO checks the lease and the revision. */
export const reviseChange: (
  principal: AgentToken,
  input: ReviseInput,
) => Effect.Effect<
  Revised,
  ChangeNotFound | LeaseStale | RevisionMismatch | ChangeStateRefused | IdempotencyConflict,
  Changes
> = (principal, input) => Changes.use((changes) => changes.revise(principal, input));

/** Adds one premise to a change; relying on a subject subscribes the change to it. */
export const relyOn: (
  principal: AgentToken,
  input: RelyInput,
) => Effect.Effect<
  Revised,
  ChangeNotFound | LeaseStale | ChangeStateRefused | IdempotencyConflict,
  Changes
> = (principal, input) => Changes.use((changes) => changes.rely(principal, input));

/** What is near a change now, for an agent of its project. */
export const nearbyOf: (
  principal: AgentToken,
  changeId: ChangeId,
) => Effect.Effect<Preflight, ChangeNotFound | ChangeInOtherProject, Changes> = (
  principal,
  changeId,
) => Changes.use((changes) => changes.nearby(principal, changeId));

/**
 * An abandon with no lease from a caller without the operator scope: only the
 * holder of the change's lease, or an operator, may withdraw it.
 */
export class LeaseRequired extends Schema.TaggedError<LeaseRequired>()("LeaseRequired", {
  changeId: ChangeId,
}) {}

/**
 * Who withdraws: the lease when the caller sent one, else an operator when its
 * token carries the scope. Decided from the scope alone, never from who holds
 * the change; whether the lease is the change's is the Change DO's to say.
 */
const withdrawAuthority = (
  principal: AgentToken,
  lease: LeaseId | undefined,
): WithdrawAuthority | undefined => {
  if (lease !== undefined) return { _tag: "Lease", leaseId: lease };
  return principal.scopes.includes("operator")
    ? { _tag: "Operator", by: principal.agentId }
    : undefined;
};

/** Withdraws a change under its lease, or as an operator. The Change DO checks the lease and the state. */
export const abandonChange: (
  principal: AgentToken,
  call: AbandonCall,
) => Effect.Effect<
  Change,
  ChangeNotFound | LeaseStale | ChangeStateRefused | IdempotencyConflict | LeaseRequired,
  Changes
> = (principal, call) => {
  const { lease, ...rest } = call;
  const authority = withdrawAuthority(principal, lease);
  return authority === undefined
    ? Effect.fail(new LeaseRequired({ changeId: call.changeId }))
    : Changes.use((changes) => changes.abandon(principal, { ...rest, authority }));
};

/** Where a change's submission stands, waiting up to `waitSeconds` (0–30) for it to move. */
export const submissionOf: (
  changeId: ChangeId,
  waitSeconds?: number,
) => Effect.Effect<SubmissionStatus, ChangeNotFound, Changes> = (changeId, waitSeconds) =>
  Changes.use((changes) => changes.awaitSubmission(changeId, clampWait(waitSeconds)));

/** The caller's own inbox after `cursor`, waiting up to `waitSeconds` (0–30) for a notice. */
export const readInbox: (
  principal: AgentToken,
  cursor: string | undefined,
  waitSeconds?: number,
) => Effect.Effect<InboxPage, never, Inbox> = (principal, cursor, waitSeconds) =>
  Inbox.use((inbox) => inbox.read(principal.agentId, cursor, clampWait(waitSeconds)));

/**
 * The event feed after `cursor`, waiting up to `waitSeconds` (0–30, with a
 * token or without) for an event, as far as `readScope` lets the caller read.
 * A one-project page keeps only that project's events, and only the public
 * ones for a reader outside it, so it may hold fewer than `limit`, or none,
 * while its cursor still moves past the rest. A refusal answers at once,
 * before any wait.
 */
export const readEvents: (
  principal: AgentToken | null,
  input: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly waitSeconds?: number;
    readonly project?: ProjectId;
  },
) => Effect.Effect<EventFeedPage, ReadRefused, EventFeed | Projects> = (principal, input) =>
  Effect.flatMap(readScope(principal, input.project), (scope) =>
    EventFeed.use((feed) =>
      feed.read({
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        waitSeconds: clampWait(input.waitSeconds),
      }),
    ).pipe(
      Effect.map((page) =>
        scope._tag === "instance"
          ? page
          : {
              ...page,
              events: page.events.filter(
                (e) =>
                  e.project === scope.project &&
                  (scope.audience === "members" || audienceOf(e.type) === "public"),
              ),
            },
      ),
    ),
  );

/** A project's changes from the Projector's read model, newest `#n` first, as far as `viewScope` lets the caller read. */
export const readChangeList: (
  principal: AgentToken | null,
  read: Omit<ChangeListRead, "project"> & { readonly project?: ProjectId },
) => Effect.Effect<ChangeListPage, ReadRefused, ProjectViews | Projects> = (principal, read) =>
  Effect.flatMap(viewScope(principal, read.project), ({ project }) =>
    ProjectViews.use((views) => views.changes({ ...read, project })),
  );

/**
 * A change by id, from its own DO, if `projectScope` lets the caller read its
 * project. A change the caller may not read answers ChangeNotFound, as an
 * unknown one does: the caller names the change, so any other refusal would
 * tell it that the change exists.
 */
export const readChange: (
  principal: AgentToken | null,
  changeId: ChangeId,
) => Effect.Effect<ChangeRead, ChangeNotFound, Changes | Projects> = (principal, changeId) =>
  Changes.use((changes) => changes.get(changeId)).pipe(
    Effect.tap(({ projectId }) =>
      projectScope(principal, projectId).pipe(
        Effect.mapError(() => new ChangeNotFound({ changeId })),
      ),
    ),
  );

/** A project's changes and trunk at the feed's head, with the cursor to fold forward from. */
export const readSnapshot: (
  principal: AgentToken | null,
  project: ProjectId | undefined,
) => Effect.Effect<ViewSnapshot, ReadRefused, ProjectViews | Projects> = (principal, asked) =>
  Effect.flatMap(viewScope(principal, asked), ({ project }) =>
    ProjectViews.use((views) => views.snapshot(project)),
  );
