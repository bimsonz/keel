import "@typespec/http";
import "@typespec/openapi";
import "@bimsonz/mfp";
import "./common.tsp";
import "./models.tsp";

using Http;
using OpenAPI;

namespace Keel;

/** One link in a chain of reasons, with the MFP record behind it. */
model WhyLink {
  summary: string;
  record: MFP.MfpRecord;
}

model WhyChain {
  /** From the line or subject asked about, back to the decisions behind it. */
  chain: WhyLink[];
}

model WhyEnvelope is AgentEnvelope<WhyChain>;

model DecisionPage is Page<DecisionView>;

@tag("Memory")
interface Memory {
  /** Why is this line, or this subject, the way it is? Returns a cited chain of decisions and claims. */
  @summary("Why is it like this?")
  @tag("mcp")
  @operationId("why")
  @useAuth(AgentRead | SessionAuth)
  @route("/why")
  @get
  why(
    /** A repository-relative path, with `line`. */
    @query path?: string,

    @query @minValue(1) line?: int32,
    @query subject?: SubjectKey,
  ): WhyEnvelope | NotFound | StandardErrors;

  /**
   * A project's decisions, newest first. An agent reads its own project unless
   * it names another; anyone else names one. Without a token only a public
   * project is read, and a private or unknown one is the same 404.
   */
  @summary("List decisions")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/decisions")
  @get
  listDecisions(
    @query project?: ProjectId,
    @query subject?: SubjectKey,
    ...PageQuery,
  ): DecisionPage | NotFound | StandardErrors;

  /** One decision, read by whoever may read its project: one the caller may not read is the 404 of an unknown one. */
  @summary("Get a decision")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/decisions/{decisionId}")
  @get
  getDecision(@path decisionId: DecisionId): DecisionView | NotFound | StandardErrors;
}
