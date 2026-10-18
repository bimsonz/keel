import { Context, type Effect } from "effect";
import type { IdempotencyConflict } from "../../domain/identity/index.ts";
import type {
  CloseReason,
  CommentText,
  Issue,
  IssueComment,
  IssueNotFound,
  IssueNumber,
  IssueText,
  IssueTitle,
} from "../../domain/issues/index.ts";
import type { CommandActor, IssueId, ProjectId } from "../../domain/kernel/index.ts";

export interface IssueOpening {
  readonly projectId: ProjectId;
  readonly title: IssueTitle;
  readonly body: IssueText;
  readonly author: CommandActor;
  readonly idempotencyKey: string;
}

export interface IssueCommenting {
  readonly projectId: ProjectId;
  readonly number: IssueNumber;
  readonly body: CommentText;
  readonly author: CommandActor;
  readonly idempotencyKey: string;
}

export interface IssueClosing {
  readonly projectId: ProjectId;
  readonly number: IssueNumber;
  readonly reason: CloseReason;
  readonly by: CommandActor;
  readonly idempotencyKey: string;
}

export interface IssueReopening {
  readonly projectId: ProjectId;
  readonly number: IssueNumber;
  readonly by: CommandActor;
  readonly idempotencyKey: string;
}

/** A page of a project's issues, newest first; `before` continues below the last `#n` read. */
export interface IssueQuery {
  readonly projectId: ProjectId;
  readonly state?: "open" | "closed" | undefined;
  readonly before?: IssueNumber | undefined;
  readonly limit: number;
}

export interface IssuePage {
  readonly items: readonly Issue[];
  /** The `before` that reads the next page; absent on the last. */
  readonly next?: IssueNumber | undefined;
  readonly open: number;
  readonly closed: number;
}

/** One issue and its comments, oldest first. */
export interface IssueThread {
  readonly issue: Issue;
  readonly comments: readonly IssueComment[];
}

/**
 * A project's issues, which the project's own object holds (`project:<id>`).
 * Who may do each is the policy's, decided before any of these is called.
 *
 * - `open`: gives the issue the project's next `#n`, from the same sequence as
 *   its changes, so a number names one thing in a project.
 * - `comment`, `close`, `reopen`: on an issue by its `#n`; one the project has
 *   not got is `IssueNotFound`. Closing a closed issue, or reopening an open
 *   one, answers it as it stands.
 *
 * The same Idempotency-Key and body answers what the first call did; another
 * body is an IdempotencyConflict. An issue's events are committed on the
 * project.
 */
export class Issues extends Context.Service<
  Issues,
  {
    readonly open: (opening: IssueOpening) => Effect.Effect<Issue, IdempotencyConflict>;
    readonly comment: (
      commenting: IssueCommenting,
    ) => Effect.Effect<IssueComment, IssueNotFound | IdempotencyConflict>;
    readonly close: (
      closing: IssueClosing,
    ) => Effect.Effect<Issue, IssueNotFound | IdempotencyConflict>;
    readonly reopen: (
      reopening: IssueReopening,
    ) => Effect.Effect<Issue, IssueNotFound | IdempotencyConflict>;
    readonly list: (query: IssueQuery) => Effect.Effect<IssuePage>;
    readonly get: (
      projectId: ProjectId,
      number: IssueNumber,
    ) => Effect.Effect<IssueThread, IssueNotFound>;
  }
>()("keel/Issues") {}

/**
 * A project's `#n` sequence, which its changes and its issues share: `give`
 * answers the number an issue was given, giving it the next one the first
 * time. Kept by the Projector, which gives each change its `#n` as its
 * declaration arrives.
 */
export class IssueNumbers extends Context.Service<
  IssueNumbers,
  {
    readonly give: (projectId: ProjectId, issueId: IssueId) => Effect.Effect<IssueNumber>;
  }
>()("keel/IssueNumbers") {}
