import "@typespec/http";
import "@typespec/openapi";
import "./common.tsp";
import "./models.tsp";

using Http;
using OpenAPI;

namespace Keel;

model SubmitRequest {
  changeId: ChangeId;

  /** The commit in the change's workspace to submit. */
  commitSha: CommitSha;
}

model Submission {
  changeId: ChangeId;
  revision: int32;
  commitSha: CommitSha;
  state: ChangeState;

  /** Present once a verdict is issued. */
  verdict?: VerdictView;
}

model SubmissionEnvelope is AgentEnvelope<Submission>;

@tag("Submissions")
interface Submissions {
  /** Submit a commit for verification and integration. The authoritative signal: pushes alone only observe. Follow `Location` with `?wait` to long-poll. */
  @summary("Submit a change")
  @tag("mcp")
  @operationId("submit")
  @useAuth(AgentWork)
  @route("/submissions")
  @post
  submit(...LeaseHeader, ...IdempotencyKey, @body body: SubmitRequest): {
    @statusCode statusCode: 202;
    @header location: string;
    @body body: SubmissionEnvelope;
  } | NotFound | Conflict | StandardErrors;

  /** Where a submitted change is now. `?wait` long-polls until it moves. */
  @summary("Get a change's submission status")
  @tag("mcp")
  @operationId("status")
  @useAuth(AgentRead | Observer)
  @route("/changes/{changeId}/submission")
  @get
  getSubmission(@path changeId: ChangeId, ...WaitQuery): SubmissionEnvelope | NotFound | StandardErrors;
}
