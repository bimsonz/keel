import { Schema } from "effect";
import { ChangeId, CommandActor, CommentId, IssueId, ProjectId } from "../kernel/index.ts";
import { CloseReason, CommentText, IssueNumber, IssueText, IssueTitle } from "./issue.ts";

/** Someone opened an issue on the project. */
export const IssueOpened = Schema.TaggedStruct("IssueOpened", {
  projectId: ProjectId,
  issueId: IssueId,
  number: IssueNumber,
  title: IssueTitle,
  body: IssueText,
  author: CommandActor,
});

/** Someone commented on an issue, open or closed. */
export const IssueCommented = Schema.TaggedStruct("IssueCommented", {
  projectId: ProjectId,
  issueId: IssueId,
  number: IssueNumber,
  commentId: CommentId,
  body: CommentText,
  author: CommandActor,
});

/**
 * The issue was closed, and why: by a person or an agent (`by`), or by a change
 * that named it in its goal and landed (`byChange`). Exactly one of the two.
 */
export const IssueClosed = Schema.TaggedStruct("IssueClosed", {
  projectId: ProjectId,
  issueId: IssueId,
  number: IssueNumber,
  reason: CloseReason,
  by: Schema.optional(CommandActor),
  byChange: Schema.optional(ChangeId),
});

/** A closed issue was opened again. */
export const IssueReopened = Schema.TaggedStruct("IssueReopened", {
  projectId: ProjectId,
  issueId: IssueId,
  number: IssueNumber,
  by: CommandActor,
});

export const IssuesEvent = Schema.Union([IssueOpened, IssueCommented, IssueClosed, IssueReopened]);
export type IssuesEvent = typeof IssuesEvent.Type;
