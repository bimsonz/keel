import "@typespec/http";
import "@typespec/openapi";
import "./common.tsp";
import "./models.tsp";
import "./changes.tsp";

using Http;
using OpenAPI;

namespace Keel;

/** A commit of a fork's trunk, proposed back to the project the fork was taken from. */
model ProposeRequest {
  /** The fork: a project forked from this one, which the caller owns or works in. */
  fork: ProjectId;

  /** A commit on the fork's trunk: its head, or one before it. */
  commit: CommitSha;

  /** What the change achieves, in one or two sentences. "Fixes #n" closes issue #n when it lands. */
  @minLength(1)
  goal: string;
}

/** Another commit of the fork's trunk for an open proposal. */
model UpdateProposalRequest {
  commit: CommitSha;

  /** What changed since the last commit, for whoever reviews it. */
  @maxLength(65536)
  note?: string;
}

/** An approval names the commit it approves: the one the reviewer read. */
model ApproveProposalRequest {
  commit: CommitSha;
}

model RequestProposalChangesRequest {
  /** The commit the request is about: the one the reviewer read. */
  commit: CommitSha;

  /** What the proposer should change. Markdown. */
  @minLength(1)
  @maxLength(65536)
  comment: string;
}

model CloseProposalRequest {
  /** Why it is closed, kept on the change's ChangeWithdrawn. */
  reason?: string;
}

/**
 * Proposals from a fork, GitHub's pull request from a fork in Keel's nouns: a proposal is a change on this project
 * whose code comes from a fork of it. It runs Precheck, which reads its diff and runs nothing, and then waits for
 * someone holding `maintain` here to approve the commit it carries. Nothing is verified before that. Once approved it
 * is verified and lands like any change, and a new commit puts it back to waiting.
 */
@tag("Proposals")
interface Proposals {
  /**
   * Propose a commit of your fork's trunk back to the project it was forked from: it becomes a change here, `#n` and
   * all, that waits for approval (parked, `awaiting-approval`) once Precheck has read it. Keel copies the fork's
   * commits itself, so you need no token for this project. Who may: a person who is a member of the fork's namespace,
   * or an agent working in the fork that a person sponsors (403 `auth.forbidden`, reason `sponsor-required`, with
   * `askSponsor` as the way on). The project must be public and take proposals (403 reason `proposals-closed`).
   * Refused: a project not forked from this one (409 `proposal.not_a_fork`), a commit not on the fork's trunk (409
   * `proposal.commit_not_on_fork`), a commit with nothing upstream lacks (409 `proposal.empty`), a sixth open proposal
   * of yours here (409 `proposal.limit`), no workspace free (503 `workspace.pool_exhausted`, retry after the time it
   * names). A retry with the same Idempotency-Key answers the same change.
   */
  @summary("Propose a commit of a fork")
  @tag("mcp")
  @operationId("propose")
  @useAuth(AgentWork | SessionAuth)
  @route("/projects/{projectId}/proposals")
  @post
  propose(@path projectId: ProjectId, ...IdempotencyKey, @body body: ProposeRequest): {
    @statusCode statusCode: 201;
    @body body: Change;
  } | NotFound | Conflict | StandardErrors;

  /**
   * A project's proposals, newest `#n` first: `open` (the default) for those not yet landed, withdrawn or superseded,
   * `closed` for the rest. Whoever reads the project reads them; a private or unknown project is the same 404.
   */
  @summary("List a project's proposals")
  @tag("mcp")
  @operationId("proposals")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/projects/{projectId}/proposals")
  @get
  listProposals(
    @path projectId: ProjectId,
    @query state?: "open" | "closed",
    ...PageQuery,
  ): ChangeSummaryPage | NotFound | StandardErrors;

  /**
   * Move your open proposal to another commit of the fork's trunk: Keel copies it, checks it again, and it waits for
   * approval again, whatever was approved before. Its proposer alone may (403 reason `proposer-only`). Refused while it
   * is being integrated, or once it has ended (409 `change.state_refused`); a change that is no proposal is 409
   * `change.not_a_proposal`; a commit not on the fork's trunk 409 `proposal.commit_not_on_fork`.
   */
  @summary("Propose another commit")
  @tag("mcp")
  @operationId("updateProposal")
  @useAuth(AgentWork | SessionAuth)
  @route("/changes/{changeId}/proposal/commits")
  @post
  updateProposal(
    ...ChangePath,
    ...IdempotencyKey,
    @body body: UpdateProposalRequest,
  ): Change | NotFound | Conflict | StandardErrors;

  /**
   * Approve a proposal at the commit you read: it goes back into the queue to be verified and landed. A person holding
   * `maintain` on the project may, or an agent holding it that a person sponsors. The approval names that commit
   * alone: a proposal at another one is 409 `proposal.commit_moved`, naming the commit it carries now, and a later
   * commit clears it. A change to how Keel verifies is still put to a person as its own question once approved.
   * Refused unless it waits for approval (409 `change.state_refused`).
   */
  @summary("Approve a proposal")
  @tag("mcp")
  @operationId("approveProposal")
  @useAuth(AgentRead | SessionAuth)
  @route("/changes/{changeId}/proposal/approval")
  @post
  approveProposal(
    ...ChangePath,
    ...IdempotencyKey,
    @body body: ApproveProposalRequest,
  ): Change | NotFound | Conflict | StandardErrors;

  /**
   * Ask the proposer for changes, at the commit you read: the proposal goes on waiting, and its proposer is told what
   * you asked. Who may, and the refusals, are as for an approval.
   */
  @summary("Request changes to a proposal")
  @tag("mcp")
  @operationId("requestProposalChanges")
  @useAuth(AgentRead | SessionAuth)
  @route("/changes/{changeId}/proposal/changes-requested")
  @post
  requestProposalChanges(
    ...ChangePath,
    ...IdempotencyKey,
    @body body: RequestProposalChangesRequest,
  ): Change | NotFound | Conflict | StandardErrors;

  /**
   * Close a proposal: the change is withdrawn and its workspace let go. Its proposer may, and whoever may approve it.
   * Refused while it is being integrated, or once it has ended (409 `change.state_refused`).
   */
  @summary("Close a proposal")
  @tag("mcp")
  @operationId("closeProposal")
  @useAuth(AgentRead | SessionAuth)
  @route("/changes/{changeId}/proposal/close")
  @post
  closeProposal(
    ...ChangePath,
    ...IdempotencyKey,
    @body body: CloseProposalRequest,
  ): Change | NotFound | Conflict | StandardErrors;
}
