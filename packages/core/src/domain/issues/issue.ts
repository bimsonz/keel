import { Schema } from "effect";
import {
  ChangeId,
  CommandActor,
  CommentId,
  InstantSchema,
  IssueId,
  ProjectId,
} from "../kernel/index.ts";

/** An issue's title: one line of at most 256 characters, with no space at either end. */
export const IssueTitle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^\S(?:.*\S)?$/),
);
export type IssueTitle = typeof IssueTitle.Type;

/** An issue's or a comment's text: Markdown, at most 64 KiB of it. */
export const IssueText = Schema.String.check(Schema.isMaxLength(65_536));
export type IssueText = typeof IssueText.Type;

/** A comment's text, which says something: Markdown, at most 64 KiB. */
export const CommentText = IssueText.check(Schema.isPattern(/\S/));
export type CommentText = typeof CommentText.Type;

/** Why an issue was closed: GitHub's three. */
export const CloseReason = Schema.Literals(["completed", "not-planned", "duplicate"]);
export type CloseReason = typeof CloseReason.Type;

/** An issue's `#n`: counted per project, from the same sequence as its changes. */
export const IssueNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export type IssueNumber = typeof IssueNumber.Type;

/**
 * Something someone asked of a project: a bug, a request, a question. It is
 * apart from any change: a change may close it when it lands, and nothing else
 * ties the two. `author` is the person or the agent who opened it. A closed
 * issue says why, and who or which change closed it.
 */
export const Issue = Schema.Struct({
  issueId: IssueId,
  projectId: ProjectId,
  number: IssueNumber,
  title: IssueTitle,
  body: IssueText,
  author: CommandActor,
  state: Schema.Literals(["open", "closed"]),
  openedAt: InstantSchema,
  updatedAt: InstantSchema,
  comments: Schema.Int,
  closedReason: Schema.optional(CloseReason),
  closedBy: Schema.optional(CommandActor),
  closedByChange: Schema.optional(ChangeId),
  closedAt: Schema.optional(InstantSchema),
});
export type Issue = typeof Issue.Type;

/** One comment on an issue, kept in the order it came. */
export const IssueComment = Schema.Struct({
  commentId: CommentId,
  issueId: IssueId,
  author: CommandActor,
  body: CommentText,
  at: InstantSchema,
});
export type IssueComment = typeof IssueComment.Type;
