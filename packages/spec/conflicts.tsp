import "@typespec/http";
import "@typespec/openapi";
import "@bimsonz/mfp";
import "./common.tsp";
import "./models.tsp";
import "./events.tsp";

using Http;
using OpenAPI;

namespace Keel;

model ConflictPath {
  @path conflictId: ConflictId;
}

model ResolveRequest {
  move: Move;
  note?: string;

  /** The change on whose behalf the move is made. */
  changeId: ChangeId;
}

model Resolved {
  conflict: ConflictView;
}

model ResolvedEnvelope is AgentEnvelope<Resolved>;

/** A probe's standing: calibrating in the world matrix, admitted as a guard, discarded, or retired with its guard. */
union ProbeState {
  calibrating: "calibrating",
  admitted: "admitted",
  discarded: "discarded",
  retired: "retired",
}

/** The probe drafted for a conflict, by its id and the short name Keel gave it in the project (`P-n`). */
model ConflictProbeRef {
  id: ProbeId;
  label?: string;
  state: ProbeState;
}

/** The guard a conflict's probe became (`G-n`). */
model ConflictGuardRef {
  id: GuardId;
  label?: string;
}

/** The escalation a conflict was raised to a person with (`E-n`); `open` until the conflict is resolved. */
model ConflictEscalationRef {
  id: EscalationId;
  label?: string;
  open: boolean;
}

/** The decision that resolved a conflict (`D-n`). */
model ConflictDecisionRef {
  id: DecisionId;
  label?: string;
}

/** One conflict in a project's list. */
model ConflictRow {
  ...ConflictView;

  /** Keel's short name for the conflict in its project, `C-n`. It never changes once given. */
  label: string;

  predicate?: MFP.Predicate;
  probe?: ConflictProbeRef;
  guard?: ConflictGuardRef;
  escalation?: ConflictEscalationRef;
  decision?: ConflictDecisionRef;
}

/** How many conflicts the list holds open and settled (dismissed or resolved), whatever the page and its filters show. */
model ConflictTotals {
  open: int32;
  settled: int32;
}

model ConflictPage is Page<ConflictRow> {
  totals: ConflictTotals;
}

/** What Keel told a party about a conflict: its change was bounced over it, or the conflict was noted on it. */
model ConflictTold {
  how: "bounced" | "noted";
  nextActions: NextAction[];
  at: utcDateTime;
}

/** One side of a conflict as Keel knows it: the change, and what it holds on the contested subject. */
model ConflictSide {
  changeId: ChangeId;

  /** `premise`: the change relies on the proposition. `effect`: its code makes it so. */
  role: "premise" | "effect";

  proposition: EventProposition;

  /**
   * On the effect's side: how the effect is known, as fallout judged it. The
   * agent's own declared claim, or what Keel derived and by which method.
   * Absent on the premise's side, and on a conflict suspected before Keel
   * recorded it.
   */
  evidence?: SuspectEvidence;

  told?: ConflictTold;
}

/** `holder` relies on the premise and is world A of the matrix; `other` makes the effect against it and is world B. */
model ConflictSides {
  holder: ConflictSide;
  other: ConflictSide;
}

/** A probe's or a suite's answer in one world. `n/a`: it did not apply there; it is never a pass. */
union MatrixOutcome {
  pass: "pass",
  fail: "fail",
  notApplicable: "n/a",
}

/** One run of the conflict's probe in a world. */
model MatrixProbeRun {
  run: int32;
  outcome: MatrixOutcome;

  /** Where the run's result is kept. */
  resultRef: string;

  at: utcDateTime;
}

/** A suite's latest run in a world: `suite:trunk`, or `suite:<changeId>` for a side's own. */
model MatrixCheck {
  check: string;
  run: int32;
  outcome: MatrixOutcome;
  counts?: WorldCheckCounts;

  /** Why the suite did not apply, for `n/a`. */
  reason?: string;

  at: utcDateTime;
}

/** One world of a conflict's matrix, with what Keel has recorded there: nothing yet is two empty lists. */
model MatrixWorld {
  world: World;

  /** The probe's runs, in run order. */
  probe: MatrixProbeRun[];

  checks: MatrixCheck[];
}

/** Why a probe was discarded, in ProbeDiscarded's words; `detail` says why its drafts failed. */
model ProbeDiscard {
  reason: "non-discriminating" | "unstable" | "draft-failed";
  detail?:
    | "schema"
    | "truncated"
    | "abstained"
    | "repairs-exhausted"
    | "incomplete"
    | "no-propositions"
    | "no-submission"
    | "party-gone"
    | "worlds-unbuildable";
}

/** What proved a conflict, as ConflictProven carries it. */
model ConflictProof {
  _tag: "probe" | "guard" | "merge-refused" | "interaction";
  probeId?: ProbeId;
  guardId?: GuardId;
  batchId?: BatchId;
}

/** A conflict's probe: how many drafts it took, the bundle its source is in, and why it was discarded if it was. */
model ConflictProbe {
  ...ConflictProbeRef;
  attempts?: int32;
  bundleHash?: ContentHash;
  discarded?: ProbeDiscard;
}

/** The guard a conflict's probe became, and whether a decision has retired it. */
model ConflictGuard {
  ...ConflictGuardRef;
  state: "admitted" | "retired";
  admittedAt: utcDateTime;
  probeId: ProbeId;

  /** The discriminating runs that admitted it. */
  runs: int32;
}

model ConflictEscalation {
  ...ConflictEscalationRef;
  reason?: "human-class" | "unprovable";

  /**
   * What the person was asked. The question, its state, its options and its
   * evidence are read by the project's members; any other reader of a public
   * project sees that a person was asked, and no more.
   */
  question?: string;

  state?: "open" | "ruled" | "withdrawn";
  options?: EscalationOption[];
  evidence?: EscalationEvidence[];
}

/** The option a ruling chose: its id among the escalation's options, and its label. */
model ConflictChoice {
  id: string;
  label: string;
}

/** The decision that resolved a conflict, with what it chose once Keel has heard it recorded. */
model ConflictDecision {
  ...ConflictDecisionRef;
  chosen?: ConflictChoice;
}

/**
 * One conflict: its two sides, its probe, its world matrix and its guard, as
 * Keel folded them from the conflict's own events. States and outcomes are the
 * events' words. What Keel has no record of is absent.
 */
model ConflictDetail {
  ...ConflictView;

  /** Keel's short name for the conflict in its project, `C-n`. It never changes once given. */
  label: string;

  predicate?: MFP.Predicate;

  /** `fallout`: two changes' declared or derived claims contradict. `opinion`: a decision model suspects it. */
  origin?: "fallout" | "opinion";

  /** When it was dismissed or resolved. */
  settledAt?: utcDateTime;

  /** How it was proven. */
  proven?: ConflictProof;

  /** Why it was dismissed. */
  dismissed?: string;

  /** Absent when the suspicion named no premise and effect. */
  sides?: ConflictSides;

  /** Always the five worlds, in the order trunk, A-noop, A, B, AB. */
  matrix: MatrixWorld[];

  probe?: ConflictProbe;
  guard?: ConflictGuard;
  escalation?: ConflictEscalation;
  decision?: ConflictDecision;

  /** The move that resolved it. */
  move?: Move;
}

@tag("Conflicts")
@route("/conflicts")
interface Conflicts {
  /**
   * A project's conflicts, newest first, with how many are open and settled.
   * An agent reads its own project unless it names another; anyone else names
   * one. Without a token only a public project is read, and a private or
   * unknown one is the same 404.
   */
  @summary("List conflicts")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @get
  listConflicts(
    @query project?: ProjectId,

    /** Only open conflicts, or only settled ones (dismissed or resolved). */
    @query open?: boolean,

    /** Only the conflicts this change is a party to. */
    @query changeId?: ChangeId,

    @query state?: ConflictState,
    ...PageQuery,
  ): ConflictPage | NotFound | StandardErrors;

  /**
   * One conflict of a project. An agent's own project unless `project` names
   * another. A conflict the caller may not read is the 404 of an unknown one.
   */
  @summary("Get a conflict")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/{conflictId}")
  @get
  getConflict(...ConflictPath, @query project?: ProjectId): ConflictDetail | NotFound | StandardErrors;

  /** Resolve a conflict with a move: sequence, yield, merge, distinguish, escalate… */
  @summary("Resolve a conflict")
  @tag("mcp")
  @operationId("resolve")
  @useAuth(AgentWork)
  @route("/{conflictId}/resolution")
  @post
  resolve(
    ...ConflictPath,
    ...LeaseHeader,
    ...IdempotencyKey,
    @body body: ResolveRequest,
  ): ResolvedEnvelope | NotFound | Conflict | StandardErrors;
}

model ProbePath {
  @path probeId: ProbeId;
}

/** One file of a probe's source, as its bundle holds it. */
model ProbeSourceFile {
  /** The file's path under `.keel/`. */
  path: string;

  text: string;
}

/** A probe's source: the files of the bundle its last draft was kept under. */
model ProbeSource {
  probeId: ProbeId;

  /** Absent when none of the probe's drafts compiled: it has no source. */
  bundleHash?: ContentHash;

  /**
   * The bundle's files. None when the probe has no bundle, and none beside a
   * `bundleHash` when that bundle is no longer kept.
   */
  files: ProbeSourceFile[];
}

@tag("Conflicts")
@route("/probes")
interface Probes {
  /**
   * The source of a conflict's probe, as it was run in each world. An agent's
   * own project unless `project` names another. A probe the caller may not
   * read is the 404 of an unknown one.
   */
  @summary("Read a probe's source")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/{probeId}/source")
  @get
  getProbeSource(...ProbePath, @query project?: ProjectId): ProbeSource | NotFound | StandardErrors;
}
