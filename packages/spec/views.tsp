import "@typespec/http";
import "./common.tsp";
import "./models.tsp";

using Http;

namespace Keel;

model LaneView {
  id: string;
  projectId: ProjectId;
  queued: int32;
  inFlight: int32;
}

model TrunkView {
  projectId: ProjectId;
  head: CommitSha;
  advancedAt: utcDateTime;
  frozen: boolean;
}

model LanePage is Page<LaneView>;

@tag("Views")
interface Views {
  @summary("Get a verdict")
  @useAuth(AgentRead | SessionAuth)
  @route("/verdicts/{verdictId}")
  @get
  getVerdict(@path verdictId: VerdictId): VerdictView | NotFound | StandardErrors;

  @summary("List a project's lanes")
  @useAuth(AgentRead | SessionAuth)
  @route("/projects/{projectId}/lanes")
  @get
  listLanes(@path projectId: ProjectId, ...PageQuery): LanePage | NotFound | StandardErrors;

  @summary("Get a project's trunk")
  @useAuth(AgentRead | SessionAuth)
  @route("/projects/{projectId}/trunk")
  @get
  getTrunk(@path projectId: ProjectId): TrunkView | NotFound | StandardErrors;
}
