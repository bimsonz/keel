import {
  type ChangeId,
  type CommandActor,
  type Committed,
  type CommentId,
  IllegalTransition,
  type IssueId,
  type ProjectId,
} from "../kernel/index.ts";
import {
  IssueClosed,
  IssueCommented,
  IssueOpened,
  IssueReopened,
  type IssuesEvent,
} from "./events.ts";
import type {
  CloseReason,
  CommentText,
  Issue,
  IssueNumber,
  IssueText,
  IssueTitle,
} from "./issue.ts";

/** A command on one issue. Who may give it is the policy's to decide, before this. */
export type IssueCommand =
  | {
      readonly _tag: "Open";
      readonly title: IssueTitle;
      readonly body: IssueText;
      readonly author: CommandActor;
    }
  | {
      readonly _tag: "Comment";
      readonly commentId: CommentId;
      readonly body: CommentText;
      readonly author: CommandActor;
    }
  | { readonly _tag: "Close"; readonly reason: CloseReason; readonly by: CommandActor }
  /** A change that named the issue in its goal landed: it closed the issue as done. */
  | { readonly _tag: "CloseByChange"; readonly changeId: ChangeId }
  | { readonly _tag: "Reopen"; readonly by: CommandActor };

/** Facts from I/O: the project, and the issue's id and `#n`, which the project's sequence gave it. */
export interface IssueFacts {
  readonly projectId: ProjectId;
  readonly issueId: IssueId;
  readonly number: IssueNumber;
}

const notTheIssue = (issue: Issue, facts: IssueFacts): never => {
  throw new IllegalTransition(
    `a command on ${facts.issueId} was decided against the record of ${issue.issueId}, which its facts do not name`,
  );
};

const missing = (command: IssueCommand, facts: IssueFacts): never => {
  throw new IllegalTransition(
    `${command._tag} was decided on ${facts.issueId}, which was never opened: the caller answers a missing issue`,
  );
};

/**
 * Decides a command on an issue (docs/domain/state-machines.md § Issue). An
 * issue is opened once: opening one that stands commits nothing, as a retry.
 * Anyone the policy let through comments, open or closed. Closing a closed
 * issue, or reopening an open one, commits nothing: two people who press at
 * once both see it done. A change that named the issue closes it as
 * `completed`.
 *
 * A command on an issue that was never opened is the caller's mistake (the
 * use-case answers `IssueNotFound` first) and throws `IllegalTransition`, as
 * does a record of another issue.
 */
export const decideIssue = (
  issue: Issue | undefined,
  command: IssueCommand,
  facts: IssueFacts,
): readonly IssuesEvent[] => {
  if (issue !== undefined && issue.issueId !== facts.issueId) return notTheIssue(issue, facts);
  const { projectId, issueId, number } = facts;
  if (command._tag === "Open")
    return issue === undefined
      ? [
          IssueOpened.make({
            projectId,
            issueId,
            number,
            title: command.title,
            body: command.body,
            author: command.author,
          }),
        ]
      : [];
  if (issue === undefined) return missing(command, facts);
  switch (command._tag) {
    case "Comment":
      return [
        IssueCommented.make({
          projectId,
          issueId,
          number,
          commentId: command.commentId,
          body: command.body,
          author: command.author,
        }),
      ];
    case "Close":
      return issue.state === "open"
        ? [IssueClosed.make({ projectId, issueId, number, reason: command.reason, by: command.by })]
        : [];
    case "CloseByChange":
      return issue.state === "open"
        ? [
            IssueClosed.make({
              projectId,
              issueId,
              number,
              reason: "completed",
              byChange: command.changeId,
            }),
          ]
        : [];
    case "Reopen":
      return issue.state === "closed"
        ? [IssueReopened.make({ projectId, issueId, number, by: command.by })]
        : [];
    default: {
      const unreachable: never = command;
      return unreachable;
    }
  }
};

const illegal = (state: Issue | undefined, event: IssuesEvent): never => {
  throw new IllegalTransition(
    `${event._tag} cannot apply to an issue ${state === undefined ? "never opened" : state.state}`,
  );
};

/**
 * Folds one committed event into the issue. An event of another issue, or one
 * its state cannot take (a comment on an issue never opened, a close of a closed
 * one), throws `IllegalTransition`.
 */
export const evolveIssue = (state: Issue | undefined, committed: Committed<IssuesEvent>): Issue => {
  const { at, payload } = committed;
  if (state !== undefined && state.issueId !== payload.issueId)
    throw new IllegalTransition(
      `${payload._tag} of ${payload.issueId} folded into ${state.issueId}`,
    );
  switch (payload._tag) {
    case "IssueOpened":
      if (state !== undefined) return illegal(state, payload);
      return {
        issueId: payload.issueId,
        projectId: payload.projectId,
        number: payload.number,
        title: payload.title,
        body: payload.body,
        author: payload.author,
        state: "open",
        openedAt: at,
        updatedAt: at,
        comments: 0,
      };
    case "IssueCommented":
      if (state === undefined) return illegal(state, payload);
      return { ...state, comments: state.comments + 1, updatedAt: at };
    case "IssueClosed": {
      if (state === undefined || state.state !== "open") return illegal(state, payload);
      return {
        ...state,
        state: "closed",
        closedReason: payload.reason,
        ...(payload.by === undefined ? {} : { closedBy: payload.by }),
        ...(payload.byChange === undefined ? {} : { closedByChange: payload.byChange }),
        closedAt: at,
        updatedAt: at,
      };
    }
    case "IssueReopened": {
      if (state === undefined || state.state !== "closed") return illegal(state, payload);
      const {
        closedReason: _reason,
        closedBy: _by,
        closedByChange: _change,
        closedAt: _at,
        ...open
      } = state;
      return { ...open, state: "open", updatedAt: at };
    }
    default: {
      const unreachable: never = payload;
      return unreachable;
    }
  }
};
