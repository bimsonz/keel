import "@typespec/http";
import "./common.tsp";
import "./models.tsp";

using Http;

namespace Keel;

model CandidateView {
  id: CandidateId;
  batchId: string;
  members: ChangeId[];
  state: "forming" | "assembled" | "verifying" | "green" | "red" | "bisected" | "promoted" | "invalidated";
  tier: 0 | 1 | 2;
}

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

  /** How many times trunk has been red. The claim is that this stays zero. */
  redCount: int32;
}

model LanePage is Page<LaneView>;

@tag("Views")
interface Views {
  @summary("Get a verdict")
  @useAuth(AgentRead | Observer)
  @route("/verdicts/{verdictId}")
  @get
  getVerdict(@path verdictId: VerdictId): VerdictView | NotFound | StandardErrors;

  @summary("Get a candidate")
  @useAuth(AgentRead | Observer)
  @route("/candidates/{candidateId}")
  @get
  getCandidate(@path candidateId: CandidateId): CandidateView | NotFound | StandardErrors;

  @summary("List a project's lanes")
  @useAuth(AgentRead | Observer)
  @route("/projects/{projectId}/lanes")
  @get
  listLanes(@path projectId: ProjectId, ...PageQuery): LanePage | NotFound | StandardErrors;

  @summary("Get a project's trunk")
  @useAuth(AgentRead | Observer)
  @route("/projects/{projectId}/trunk")
  @get
  getTrunk(@path projectId: ProjectId): TrunkView | NotFound | StandardErrors;
}
