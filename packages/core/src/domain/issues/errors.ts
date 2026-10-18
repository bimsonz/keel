import { Schema } from "effect";
import { ProjectId } from "../kernel/index.ts";
import { IssueNumber } from "./issue.ts";

/** The project has no issue of that number. */
export class IssueNotFound extends Schema.TaggedError<IssueNotFound>()("IssueNotFound", {
  projectId: ProjectId,
  number: IssueNumber,
}) {}
