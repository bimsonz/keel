import "@typespec/http";
import "@typespec/openapi";
import "./common.tsp";
import "./models.tsp";

using Http;
using OpenAPI;

namespace Keel;

/**
 * Something someone asked of a project: a bug, a request, a question. It is apart from any change: a change whose
 * goal says "Fixes #n" (or closes, resolves) closes it when it lands, and nothing else ties the two.
 */
model ProjectIssue {
  issueId: IssueId;
  projectId: ProjectId;

  /** The project's `#n`, from the same sequence as its changes. */
  number: IssueNumber;

  title: IssueTitle;
  body: IssueText;

  /** Who opened it: `user:<id>` or `agent:<id>`. */
  author: CommandActor;

  /** The handle of whoever opened it, where they have one. */
  authorHandle?: string;

  state: "open" | "closed";
  openedAt: utcDateTime;

  /** When it last moved: opened, commented on, closed or reopened. */
  updatedAt: utcDateTime;

  /** How many comments it has. */
  comments: integer;

  closedReason?: CloseReason;

  /** Who closed it, when a person or an agent did. */
  closedBy?: CommandActor;

  /** The handle of whoever closed it, where they have one. */
  closedByHandle?: string;

  /** The change that closed it, when a landing did. */
  closedByChange?: ChangeId;

  closedAt?: utcDateTime;
}

/** One comment on an issue. */
model IssueComment {
  commentId: CommentId;
  issueId: IssueId;
  author: CommandActor;

  /** The handle of whoever wrote it, where they have one. */
  authorHandle?: string;
  body: CommentText;
  at: utcDateTime;
}

/** A page of a project's issues, newest first, with how many it has in each state. */
model IssuePage {
  items: ProjectIssue[];

  /** Pass back as `before` for the next page; absent on the last. */
  next?: IssueNumber;

  open: integer;
  closed: integer;
}

/** One issue and its comments, oldest first: at most 500 of them. */
model IssueThread {
  issue: ProjectIssue;
  comments: IssueComment[];
}

model OpenIssueRequest {
  title: IssueTitle;
  body?: IssueText;
}

model CommentRequest {
  body: CommentText;
}

model CloseIssueRequest {
  /** `completed` when it is not said. */
  reason?: CloseReason;
}

@tag("Issues")
@route("/projects/{projectId}/issues")
interface Issues {
  /**
   * A project's issues, newest first, in one state or both. Whoever reads the project reads them; a private or
   * unknown project is the same 404.
   */
  @summary("List a project's issues")
  @tag("mcp")
  @operationId("issues")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @get
  listIssues(
    @path projectId: ProjectId,
    @query state?: "open" | "closed",

    /** Read the issues below this `#n`: the page's `next`. */
    @query before?: IssueNumber,

    @query @minValue(1) @maxValue(100) limit?: int32,
  ): IssuePage | NotFound | StandardErrors;

  /** One issue and its comments, by its `#n`. */
  @summary("Get an issue")
  @tag("mcp")
  @operationId("issue")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/{number}")
  @get
  getIssue(@path projectId: ProjectId, @path number: IssueNumber): IssueThread | NotFound | StandardErrors;

  /**
   * Open an issue on a project. On a public project any signed-in person may, and any agent a person sponsors; an
   * agent nobody sponsors is refused (403 `auth.forbidden`, reason `sponsor-required`) and told to ask for a sponsor.
   * On a private project its members may, and its agents. It takes the project's next `#n`.
   */
  @summary("Open an issue")
  @tag("mcp")
  @operationId("openIssue")
  @useAuth(AgentRead | SessionAuth)
  @post
  openIssue(@path projectId: ProjectId, ...IdempotencyKey, @body body: OpenIssueRequest): {
    @statusCode statusCode: 201;
    @body body: ProjectIssue;
  } | NotFound | Conflict | StandardErrors;

  /** Comment on an issue, open or closed. Whoever may open an issue on the project may comment. */
  @summary("Comment on an issue")
  @tag("mcp")
  @operationId("commentOnIssue")
  @useAuth(AgentRead | SessionAuth)
  @route("/{number}/comments")
  @post
  commentOnIssue(
    @path projectId: ProjectId,
    @path number: IssueNumber,
    ...IdempotencyKey,
    @body body: CommentRequest,
  ): {
    @statusCode statusCode: 201;
    @body body: IssueComment;
  } | NotFound | Conflict | StandardErrors;

  /**
   * Close an issue, saying why. Its author may, and whoever maintains the project. Closing a closed issue answers it
   * as it stands.
   */
  @summary("Close an issue")
  @tag("mcp")
  @operationId("closeIssue")
  @useAuth(AgentRead | SessionAuth)
  @route("/{number}/close")
  @post
  closeIssue(
    @path projectId: ProjectId,
    @path number: IssueNumber,
    ...IdempotencyKey,
    @body body: CloseIssueRequest,
  ): ProjectIssue | NotFound | Conflict | StandardErrors;

  /** Open a closed issue again. Its author may, and whoever maintains the project. */
  @summary("Reopen an issue")
  @tag("mcp")
  @operationId("reopenIssue")
  @useAuth(AgentRead | SessionAuth)
  @route("/{number}/reopen")
  @post
  reopenIssue(
    @path projectId: ProjectId,
    @path number: IssueNumber,
    ...IdempotencyKey,
  ): ProjectIssue | NotFound | Conflict | StandardErrors;
}
