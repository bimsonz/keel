import "@typespec/http";
import "@typespec/openapi";
import "@bimsonz/mfp";
import "./common.tsp";
import "./models.tsp";

using Http;
using OpenAPI;

namespace Keel;

/** Who stated a message: a person, an agent, or Keel itself. */
model RecordAuthor {
  kind: "human" | "agent" | "platform";
  id: string;
}

/**
 * Keel's own record of an MFP message: who stated it, when, for which change,
 * the class of evidence it rests on and where it holds, which MFP 0.2 leaves to
 * the receiver. The message itself is MFP 0.2.
 */
model KeelRecord {
  id: string;
  author: RecordAuthor;
  at: utcDateTime;
  change?: ChangeId;
  evidenceClass?: EvidenceClass;
  scope?: string;
  message: MFP.Message;
}

/** One link in a chain of reasons, with Keel's record of the MFP message behind it. */
model WhyLink {
  summary: string;
  record: KeelRecord;
}

model WhyChain {
  /** From the line or subject asked about, back to the decisions behind it. */
  chain: WhyLink[];
}

model WhyEnvelope is AgentEnvelope<WhyChain>;

model DecisionPage is Page<DecisionView>;

@tag("Memory")
interface Memory {
  /**
   * Why is this file, or this subject, the way it is? Name a `path` or a
   * `subject`, not both. Each active decision on the subject, or on a subject
   * anchored in the file, answers with its chain, newest decision first: the
   * decision, the premise its conflict was about, the intent of the change
   * whose effect met it, each guard that holds it, and each change that landed
   * under it, every link an MFP 0.2 message in Keel's record. A subject's
   * anchors name a file and no lines, so `line` does not narrow: a path with a
   * line answers every subject anchored in that file. An agent reads its own
   * project unless it names another; anyone else names one. Nothing to explain
   * in the project read is 404 `why.nothing_to_explain`. Without a token only a
   * public project is read, and a private or unknown one, like any the caller
   * may not see, is the same 404. A refusal about the caller itself (a token's
   * scope, a suspension, a paused agent) is 403 with its next action.
   */
  @summary("Why is it like this?")
  @tag("mcp")
  @operationId("why")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/why")
  @get
  why(
    @query project?: ProjectId,

    /** A repository-relative path, as a subject's anchors name it. */
    @query path?: string,

    /** A line in `path`. Anchors carry no span, so it does not narrow the answer. */
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
