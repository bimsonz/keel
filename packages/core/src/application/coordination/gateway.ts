import { Effect, Result, Schema } from "effect";
import {
  type Change,
  type ChangeInOtherProject,
  ChangeNotFound,
  checkLease,
  type Move,
  type ChangeStateRefused,
  type CommitNotInWorkspace,
  type LeaseNotLapsed,
  type LeaseStale,
  type PoolExhausted,
  type Preflight,
  type RevisionMismatch,
  type SketchNotFound,
} from "../../domain/coordination/index.ts";
import type {
  Audience,
  IdempotencyConflict,
  InboxPage,
  AgentToken,
} from "../../domain/identity/index.ts";
import {
  ChangeId,
  type ConflictId,
  type ContentHash,
  type LeaseId,
  type ProbeId,
  type ProjectId,
  type UserId,
} from "../../domain/kernel/index.ts";
import {
  type ConflictNotFound,
  MoveRefused,
  type ProbeNotFound,
} from "../../domain/verification/index.ts";
import {
  type ChangeListPage,
  type ChangeListRead,
  type ChangeRead,
  Changes,
  Clock,
  type ConflictListPage,
  type ConflictListRead,
  ConflictMoves,
  type ConflictRecord,
  type ConflictView,
  type EscalationListRead,
  type EscalationReader,
  Escalations,
  EventFeed,
  type EventFeedEntry,
  type EventFeedPage,
  Inbox,
  type LabelledEscalation,
  ProbeStore,
  type ProjectOrgs,
  ProjectViews,
  type RulingCommand,
  type RulingRefusal,
  type SubmissionStatus,
  type ViewSnapshot,
} from "../ports/index.ts";
import type { PushRejected } from "../../domain/integration/index.ts";
import type { PackTooLarge } from "../ports/index.ts";
import { projectNamespace } from "../verification/index.ts";
import type { RebasedChange, Withdrawal } from "./change.ts";
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
import { audienceOf, type FeedScope, type ProjectScope } from "./read-scope.ts";

/**
 * The isolate's side of the work loop. The doorways have already authorised
 * the call on its project; each use-case hands it to the Change or AgentSession
 * DO that decides it. Leases are authorised there and only there.
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

/** What is near a change now, for a reader of `projectId`: a change of another project is ChangeInOtherProject. */
export const nearbyOf: (
  projectId: ProjectId,
  changeId: ChangeId,
) => Effect.Effect<Preflight, ChangeNotFound | ChangeInOtherProject, Changes> = (
  projectId,
  changeId,
) => Changes.use((changes) => changes.nearby(projectId, changeId));

/** An abandon by an agent that sent no lease: only the holder of the change's lease, or a maintainer, may withdraw it. */
export class LeaseRequired extends Schema.TaggedError<LeaseRequired>()("LeaseRequired", {
  changeId: ChangeId,
}) {}

/**
 * Who withdraws a change, as the doorway authorised them on its project: an
 * agent, which must hold the change's lease, or a maintainer of the project,
 * who needs none.
 */
export type Withdrawer =
  | { readonly _tag: "Agent"; readonly token: AgentToken }
  | { readonly _tag: "Maintainer"; readonly userId: UserId; readonly projectId: ProjectId };

/**
 * What the Change DO is told: an agent's lease, when it sent one, or the
 * maintainer and the project they maintain. Whether the lease is the change's,
 * and the project the change's, is the Change DO's to say.
 */
const withdrawal = (by: Withdrawer, lease: LeaseId | undefined): Withdrawal | undefined => {
  switch (by._tag) {
    case "Agent":
      return lease === undefined
        ? undefined
        : { _tag: "Lease", leaseId: lease, agentId: by.token.agentId };
    case "Maintainer":
      return { _tag: "Maintainer", by: by.userId, projectId: by.projectId };
    default: {
      const unreachable: never = by;
      return unreachable;
    }
  }
};

/** Withdraws a change under its lease, or as a maintainer. The Change DO checks the lease and the state. */
export const abandonChange: (
  by: Withdrawer,
  call: AbandonCall,
) => Effect.Effect<
  Change,
  ChangeNotFound | LeaseStale | ChangeStateRefused | IdempotencyConflict | LeaseRequired,
  Changes
> = (by, call) => {
  const { lease, ...rest } = call;
  const authority = withdrawal(by, lease);
  return authority === undefined
    ? Effect.fail(new LeaseRequired({ changeId: call.changeId }))
    : Changes.use((changes) => changes.abandon({ ...rest, authority }));
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
 * Whether a reader who sees the event's project as `audience` reads it: all of
 * it as a member, its public events as the public, and none of it where
 * `audience` is undefined.
 */
const readable = (event: EventFeedEntry, audience: Audience | undefined): boolean =>
  audience !== undefined && (audience === "members" || audienceOf(event.type) === "public");

/**
 * The events of a page the scope reads: one project's, or each one whose
 * project is readable, asked once per project; of those, what `readable` keeps.
 * A project's page is already sought by project in the feed; the check here
 * stays, so a feed that did not seek (an older Projector answering a newer
 * doorway) still serves a reader nothing of another project.
 */
const kept = (
  scope: FeedScope,
  events: readonly EventFeedEntry[],
): Effect.Effect<readonly EventFeedEntry[]> => {
  if (scope._tag === "Project")
    return Effect.succeed(
      events.filter((e) => e.project === scope.project && readable(e, scope.audience)),
    );
  const projects = [
    ...new Set(events.flatMap((e) => (e.project === undefined ? [] : [e.project]))),
  ];
  return Effect.forEach(
    projects,
    (project) => Effect.map(scope.audienceOf(project), (audience) => [project, audience] as const),
    { concurrency: 8 },
  ).pipe(
    Effect.map((audiences) => {
      const audience = new Map(audiences);
      return events.filter((e) => e.project !== undefined && readable(e, audience.get(e.project)));
    }),
  );
};

/**
 * The event feed after `cursor`, waiting up to `waitSeconds` (0–30) for an
 * event, as far as `scope` reads it. One project's read is sought through
 * that project's index in the feed, so a page is the project's next `limit`
 * and its cursor moves past every other project's events at once. A page
 * keeps only the events the scope reads, so it may hold fewer than `limit`,
 * or none, while its cursor still moves past the rest.
 */
export const readEvents: (
  scope: FeedScope,
  input: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly waitSeconds?: number;
  },
) => Effect.Effect<EventFeedPage, never, EventFeed> = (scope, input) =>
  EventFeed.use((feed) =>
    feed.read({
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      waitSeconds: clampWait(input.waitSeconds),
      ...(scope._tag === "Project" ? { project: scope.project } : {}),
    }),
  ).pipe(
    Effect.flatMap((page) =>
      Effect.map(kept(scope, page.events), (events) => ({ ...page, events })),
    ),
  );

/** A project's changes from the Projector's read model, newest `#n` first. */
export const readChangeList: (
  scope: ProjectScope,
  read: Omit<ChangeListRead, "project">,
) => Effect.Effect<ChangeListPage, never, ProjectViews> = (scope, read) =>
  ProjectViews.use((views) => views.changes({ ...read, project: scope.project }));

/**
 * A change by id, from its own DO, with its project: the doorway reads it, and
 * decides on that project, before it answers.
 */
export const readChange: (
  changeId: ChangeId,
) => Effect.Effect<ChangeRead, ChangeNotFound, Changes> = (changeId) =>
  Changes.use((changes) => changes.get(changeId));

/** A project's conflicts from the Projector's read model, newest `C-n` first. */
export const readConflictList: (
  scope: ProjectScope,
  read: Omit<ConflictListRead, "project">,
) => Effect.Effect<ConflictListPage, never, ProjectViews> = (scope, read) =>
  ProjectViews.use((views) => views.conflicts({ ...read, project: scope.project }));

/**
 * One conflict of the project the doorway authorised the read on. A conflict
 * of another project is ConflictNotFound here, as one that does not exist: the
 * caller named the conflict, and the project it was read in is not its own.
 */
export const readConflict: (
  scope: ProjectScope,
  conflictId: ConflictId,
) => Effect.Effect<ConflictRecord, ConflictNotFound, ProjectViews> = (scope, conflictId) =>
  ProjectViews.use((views) => views.conflict(scope.project, conflictId));

/** Where a project is, as a reader is shown it: its namespace's handle and its own name. */
export interface ProjectRef {
  readonly id: ProjectId;
  readonly namespace: string;
  readonly name: string;
}

/** A question put to a person, with the place of the project it is about. */
export interface PlacedEscalation {
  readonly record: LabelledEscalation;
  readonly project: ProjectRef;
}

export interface PlacedEscalationPage {
  /** Newest first. */
  readonly items: readonly PlacedEscalation[];
  readonly nextCursor?: string | undefined;
}

/**
 * A reader's escalations, newest first, each with its project's place: an
 * agent's are its project's, a person's are their inbox (`listedTo`).
 * `placeOf` is the doorway's: it answers a project's place where the policy
 * lets this reader see what the project's members see, and nothing otherwise.
 * An escalation it answers nothing for is left out, so a page may hold fewer
 * than its limit while `nextCursor` says more follow.
 */
export const readEscalationList = <R>(
  reader: EscalationReader,
  read: Omit<EscalationListRead, "reader" | "now">,
  placeOf: (project: ProjectId) => Effect.Effect<ProjectRef | undefined, never, R>,
): Effect.Effect<PlacedEscalationPage, never, Escalations | Clock | R> =>
  Effect.gen(function* () {
    const now = yield* (yield* Clock).now;
    const page = yield* Escalations.use((escalations) =>
      escalations.list({ ...read, reader, now }),
    );
    const placed = yield* Effect.forEach(page.items, (record) =>
      Effect.map(placeOf(record.project), (project) =>
        project === undefined ? [] : [{ record, project }],
      ),
    );
    return {
      items: placed.flat(),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  });

/**
 * A person's ruling on an escalation, answered with the escalation as it then
 * stands and its project's place. The doorway decided on that project before
 * this ran, so a place that is gone by now is a defect.
 */
export const ruleOnEscalation = <R>(
  command: RulingCommand,
  placeOf: (project: ProjectId) => Effect.Effect<ProjectRef | undefined, never, R>,
): Effect.Effect<PlacedEscalation, RulingRefusal, Escalations | R> =>
  Escalations.use((escalations) => escalations.rule(command)).pipe(
    Effect.flatMap((record) =>
      Effect.flatMap(placeOf(record.project), (project) =>
        project === undefined
          ? Effect.die(new Error(`${record.escalation.id} was ruled on in a project with no place`))
          : Effect.succeed({ record, project }),
      ),
    ),
  );

/** A probe's source: the files of the bundle its last draft was kept under, by path. */
export interface ProbeSource {
  readonly probeId: ProbeId;
  readonly bundleHash?: ContentHash;
  readonly files: readonly { readonly path: string; readonly text: string }[];
}

const NO_FILES: ProbeSource["files"] = [];

/**
 * The source of a probe of the project the doorway authorised the read on.
 * The Projector says which conflict the probe belongs to, and so the bundle
 * its draft was kept under; the files come from the store the Probe Workflow
 * wrote them to. A probe none of whose drafts compiled has no bundle and no
 * files. The store keeps it for the project's namespace. A bundle the store
 * no longer keeps leaves its hash and no files: the probe is there, its
 * source is not. ProbeNotFound for a probe the project
 * does not have, which is also a probe of another project.
 */
export const readProbeSource: (
  scope: ProjectScope,
  probeId: ProbeId,
) => Effect.Effect<ProbeSource, ProbeNotFound, ProjectViews | ProbeStore | ProjectOrgs> = (
  scope,
  probeId,
) =>
  Effect.gen(function* () {
    const views = yield* ProjectViews;
    const { probe } = yield* views.probeConflict(scope.project, probeId);
    const bundleHash = probe?.bundleHash;
    if (bundleHash === undefined) return { probeId, files: NO_FILES };
    const store = yield* ProbeStore;
    const files = yield* projectNamespace(scope.project).pipe(
      Effect.flatMap((namespace) => store.get(namespace, bundleHash)),
      Effect.catchTags({
        BundleMissing: () => Effect.succeed(NO_FILES),
        ProjectUnplaced: () => Effect.succeed(NO_FILES),
      }),
    );
    return { probeId, bundleHash, files };
  });

/** A project's changes and trunk at the feed's head, with the cursor to fold forward from. */
export const readSnapshot: (
  scope: ProjectScope,
) => Effect.Effect<ViewSnapshot, never, ProjectViews> = (scope) =>
  ProjectViews.use((views) => views.snapshot(scope.project));

/** A party's move on a conflict, as the doorway hands it over: the `Keel-Lease` value and the Idempotency-Key with it. */
export interface ResolveInput {
  readonly conflictId: ConflictId;
  readonly changeId: ChangeId;
  readonly lease: LeaseId;
  readonly move: Move;
  readonly note?: string | undefined;
  readonly idempotencyKey: string;
}

/**
 * A party moves on a conflict of the project the doorway authorised it in,
 * under its change's lease. The change must be that project's and the lease
 * its current one, read from the change's own DO; the conflict's subject
 * comes from the Projector, and the move is made at the Subject DO that hosts
 * the conflict, with the agent's sponsor as the person to ask first. A change
 * of another project is ChangeNotFound, as one that does not exist.
 */
export const resolveMove: (
  principal: AgentToken,
  scope: ProjectScope,
  input: ResolveInput,
) => Effect.Effect<
  ConflictView,
  ChangeNotFound | LeaseStale | ConflictNotFound | MoveRefused | IdempotencyConflict,
  Changes | ProjectViews | ConflictMoves | Clock
> = (principal, scope, input) =>
  Effect.gen(function* () {
    const { change, projectId } = yield* (yield* Changes).get(input.changeId);
    if (projectId !== scope.project)
      return yield* new ChangeNotFound({ changeId: input.changeId, nextActions: [] });
    const held = checkLease(change, input.lease, yield* (yield* Clock).now);
    if (Result.isFailure(held)) return yield* held.failure;
    const { conflict } = yield* (yield* ProjectViews).conflict(scope.project, input.conflictId);
    if (conflict.subjectKey === undefined)
      return yield* new MoveRefused({
        conflictId: input.conflictId,
        reason: "the conflict names no subject to move it on",
      });
    return yield* (yield* ConflictMoves).resolve(
      { projectId: scope.project, key: conflict.subjectKey },
      {
        conflictId: input.conflictId,
        changeId: input.changeId,
        agentId: principal.agentId,
        sponsor: principal.sponsor,
        move: input.move,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
      },
    );
  });
