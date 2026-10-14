// What the console's views read. These are projections of the event log:
// every field here is derived from events (or, where the catalogue has no
// fact yet, from an observation), never invented by a view.

import type {
  DerivedEffect,
  EvidenceClass,
  FootprintEntry,
  Predicate,
  Proposition,
  Relation,
  VerdictOutcome,
} from "../contract/mfp.ts";
import type {
  ChangeState,
  ConflictKind,
  ConflictState,
  Drift,
  ProbeDiscard,
  SuspectEvidence,
} from "../contract/keel/index.ts";
import type { FlowNode } from "../contract/provisional.ts";

// ─── Shared vocabulary ──────────────────────────────────────────────────────

/** A probe or check outcome. `n/a` means the precondition is absent; it is never a pass. */
export type Outcome = "pass" | "fail" | "n/a";

/** A cell or run that has not produced an outcome yet. */
export type Pending = "running" | "pending";

/** `A-noop` is the control: the premise holder's world with what it relies on removed. A probe must fail there. */
export type World = "trunk" | "A-noop" | "A" | "B" | "AB";

/** Where a step runs: 0 pure git, 1 a throwaway isolate, 2 a container. */
export type Tier = 0 | 1 | 2;

/**
 * Every agent is one of three, and says which: REAL is a person's own session, HOSTED one Keel runs,
 * SYNTHETIC one of the load generator's.
 */
export type AgentClass = "real" | "hosted" | "synthetic";

/**
 * An agent's class as a page shows it. `unnamed` is an agent whose enrolment this reader's log does not hold:
 * Keel reads an enrolment to its project's members, and an agent that signed itself up has none. No class is
 * written for it. Its name, where it has one, is its public card's.
 */
export type ShownClass = AgentClass | "unnamed";

// The states a change and a conflict can be in are Keel's own, from its generated wire types.
export type { ChangeState, ConflictKind, ConflictState };

export interface EvidenceItem {
  class: EvidenceClass;
  /** One line a person can read. */
  summary: string;
  /** What produced it: a probe, an extractor, the lattice, Clef, an agent. Empty where Keel does not say. */
  by: string;
  ref: string;
  /** Absent where Keel does not say when: a question's evidence carries no time. */
  at?: string;
  detail?: string;
}

// ─── Integration ────────────────────────────────────────────────────────────

export type CandidateState =
  | "forming"
  | "assembled"
  | "verifying"
  | "green"
  | "red"
  | "bisected"
  | "promoted"
  | "invalidated";

// ─── A conflict's page ──────────────────────────────────────────────────────

/** Where a conflict's two propositions sit on their predicate's lattice, as Keel's lattice has them. */
export interface Lattice {
  predicate: Predicate;
  /** One line through the lattice that holds both values, least first. Empty when there is none to draw. */
  values: string[];
  /**
   * `ranked`: both values are on the line. `unranked`: Keel's lattice does not rank them against each other,
   * and only a probe can. `unknown`: Keel's lattices have not been read, or this predicate has no order to draw.
   */
  standing: "ranked" | "unranked" | "unknown";
}

export interface PartyProposition {
  role: "premise" | "effect";
  relation: Relation;
  value: string;
  gloss: string;
  /**
   * On the effect's side, how Keel knows the effect, as its fallout judged it: the agent's own declared claim,
   * or what Keel derived and by which method. Absent on the premise's side, and where Keel's suspicion did not say.
   */
  evidence?: SuspectEvidence;
}

export interface Party {
  /** Its side of the conflict, as Keel names the worlds: A holds the premise, B alters what it relies on. */
  world: "A" | "B";
  changeId: string;
  /** The change's own name, `#n`. */
  label: string;
  /** What the change set out to do. Empty where the log read so far does not hold the change. */
  goal: string;
  agent: { label: string; class: ShownClass; harness: string };
  proposition: PartyProposition;
  /**
   * What Keel did to this side's change over the conflict, and the ways forward it gave its agent, in Keel's
   * words. Present only where one of Keel's events told the agent something: nothing is said for it otherwise.
   */
  told?: { how: "noted" | "bounced"; next: string[] };
  /**
   * Set where the conflict's resolution names this side's change as one its ruling went against. `decision` is
   * Keel's name for the decision where the log holds it, and `next` the ways forward Keel gave the agent with
   * the bounce by it.
   */
  ruledAgainst?: { decision?: string; next: string[] };
}

/** A suite's latest run in one world of the matrix, as Keel recorded it. */
export interface MatrixSuite {
  /** Keel's name for the check: `suite:trunk`, or `suite:<changeId>`. */
  check: string;
  /** Whose suite it is, in a few words: trunk's, or a side's with its change's name. */
  label: string;
  outcome: Outcome;
  passed?: number;
  total?: number;
  /** Why the suite did not apply, for `n/a`. */
  reason?: string;
}

/** One world of the matrix, with what Keel has recorded there. Nothing recorded is nothing drawn. */
export interface MatrixRow {
  id: World;
  label: string;
  gloss: string;
  /** The suites Keel ran in this world. It runs trunk's on trunk, each side's own in its world, and both in A+B. */
  suites: MatrixSuite[];
  /** The probe's runs here, in run order; a run Keel has not recorded is `pending`. Empty where no probe was drafted. */
  runs: (Outcome | Pending)[];
  reason?: string;
  /** True in the control world, where failing is what a working probe does. */
  control?: boolean;
}

export interface WorldMatrix {
  /** The probe's name, where one was drafted. */
  probe?: string;
  /** Whether the probe's runs are still coming in. */
  calibrating: boolean;
  rows: MatrixRow[];
}

export interface TimelineItem {
  at: string;
  /** The catalogue event behind this entry. */
  type: string;
  title: string;
  detail?: string;
  /** The entry the shot is about. */
  now?: boolean;
}

export interface ConflictPageState {
  conflict: {
    id: string;
    label: string;
    kind: ConflictKind;
    state: ConflictState;
    silentRetraction: boolean;
    openedAt: string;
    /** What a page calls it, in Keel's own fields: its subject and predicate, or its `C-n`. */
    title: string;
    predicate?: Predicate;
    /** `opinion` where a decision model suspected it; fallout otherwise, and where Keel does not say. */
    origin?: "fallout" | "opinion";
    /** What proved it, in a few of Keel's words. */
    proven?: string;
    /** Why Keel dismissed it, in its words. */
    dismissed?: string;
    /** The move that resolved it. */
    move?: string;
    /** What settling it has cost so far, where Keel has said. */
    costUsd?: number;
  };
  /** The question it was put to a person as, if it was, where Keel reads this reader the question. */
  escalation?: {
    id: string;
    label: string;
    question: string;
    state: "open" | "ruled" | "withdrawn";
  };
  /** Why it was put to a person, as ConflictEscalated says: its class is a person's to judge, or no probe could prove it. */
  escalated?: "human-class" | "unprovable";
  /** What it left behind once proven: the probe, admitted as a guard. */
  guard?: { label: string; state: "admitted" | "retired"; runs: number };
  /** What a person decided of it, by Keel's id for the decision and its label. */
  decision?: { id: string; label: string; chosen: string };
  /** The subject it is on. Absent where Keel's suspicion names none. */
  subject?: { key: string; gloss: string };
  lattice: Lattice;
  /** The two sides, as Keel named them. Absent where its suspicion named no premise and effect. */
  parties?: { A: Party; B: Party };
  /**
   * Every party Keel named, by its name: all the page has of a conflict with no sides. A party that is no
   * change is a tenet trunk already holds, and has no page of its own.
   */
  named: { changeId?: string; label: string }[];
  matrix: WorldMatrix;
  /**
   * What came of it: each side that Keel judged again once the conflict was settled, and how. Keel runs nothing
   * in the matrix's worlds after that, so this, and not the matrix, is where a revised change is seen to pass.
   */
  after: { changeId: string; label: string; revision: number; outcome: string; summary: string }[];
  /** Its probe, where Keel drafted one or discarded one it could not draft. */
  probe?: {
    id: string;
    label: string;
    /** How many drafts it took. Absent on a probe none of whose drafts was kept. */
    attempts?: number;
    bundleHash?: string;
    state: "calibrating" | "admitted" | "discarded" | "retired";
    /** Why it was discarded, in Keel's words. */
    discarded?: ProbeDiscard;
    /**
     * Its source, file by file, as Keel serves it. `unread` until Keel has answered, `refused` where it would
     * not; no files where the probe has no bundle, or its bundle is no longer kept.
     */
    source: "unread" | "refused" | { path: string; text: string }[];
  };
  evidence: EvidenceItem[];
  timeline: TimelineItem[];
}

// ─── A change's page ────────────────────────────────────────────────────────

/** One way a change's diff departs from what its agent declared: Keel's own shape. */
export type DriftItem = Drift;

export type StepKind =
  | "deterministic"
  | "decision-model"
  | "generative"
  | "probe"
  | "human"
  | "deploy";

export type StepOutcome =
  | "pass"
  | "fail"
  | "n/a"
  | "annotate"
  | "abstain"
  | "waiting"
  | "running"
  | "pending";

export interface PlanStep {
  id: string;
  title: string;
  kind: StepKind;
  /** Human steps run nowhere. */
  tier: Tier | null;
  /** Why this step exists for this change. */
  because: string;
  outcome: StepOutcome;
  evidenceClass: EvidenceClass;
  ms?: number;
  usd?: number;
  /** The worlds a `worlds(...)` step ran over. */
  worlds?: World[];
}

export interface DiffAnnotation {
  path: string;
  side: "additions" | "deletions";
  line: number;
  kind: "anchor" | "effect" | "premise" | "precedent";
  subjectKey: string;
  title: string;
  body: string;
  evidenceClass?: EvidenceClass;
}

export interface DiffFile {
  path: string;
  /** `null` when the change creates the file. */
  before: string | null;
  /** `null` when the change deletes it. */
  after: string | null;
}

/** One change among several with the same intent, as it stands now: what a reader sets side by side. */
export interface IntentRow {
  id: string;
  label: string;
  goal: string;
  agent: { label: string; class: ShownClass; harness: string };
  state: ChangeState;
  revision: number;
  declaredAt: string;
  /** Its latest verdict, where Keel has issued one, and how many pieces of evidence it cites. */
  verdict?: { outcome: VerdictOutcome; evidence: number };
  /** How many conflicts Keel has tied to it. */
  conflicts: number;
}

/** An alternative, as Keel told this change of it. */
export interface AlternativeRow extends IntentRow {
  /** Keel told this change's agent that the alternative landed. */
  landed?: { at: string };
  /** The ways forward Keel gave this change's agent about it, in Keel's words. */
  next: string[];
}

/** The agent a change is held by and the run it is held under, as a page links to them. */
export interface HeldUnder {
  /** What an address calls the agent that holds the change. */
  agent: string;
  /** Absent where the holder's token named no run. `label` is the agent's own word for the run. */
  run?: { id: string; label?: string; anchor: string };
}

/** The ruling a change bounced on, as far as the log names it. */
export interface RulingBounce {
  decision?: { label: string; chosen: string };
  conflict?: { id: string; label: string };
  reasons: string[];
}

export interface ChangePageState {
  change: {
    /** True where the project has verification switched off: its verdict or its landing was not verified. */
    unverified: boolean;
    id: string;
    label: string;
    state: ChangeState;
    revision: number;
    commit: string;
    /** True once Keel has derived the effects of a commit of it, whether or not it found any. */
    derived: boolean;
    /** The commit on trunk it landed as, where it has landed: Keel's own name for it, and a page of its own. */
    landedAs?: string;
    workspace: string;
    declaredAt: string;
    submittedAt?: string;
    laneLabel?: string;
  };
  agent: { label: string; class: ShownClass; harness: string; model: string };
  /** Its holder's page in this project, and the run it is held under. */
  held: HeldUnder;
  session: { id: string; messages: number };
  intent: {
    goal: string;
    footprint: FootprintEntry[];
    premises: Proposition[];
    declaredEffects: Proposition[];
  };
  /**
   * Each derived effect, and in `against` the premise it steps outside where a conflict is open over it.
   * That is read from the conflict Keel opened, never from the derivation.
   */
  derived: (DerivedEffect & { against?: string })[];
  drift: DriftItem[];
  /** Absent until Keel has issued one. */
  verdict?: {
    id: string;
    outcome: VerdictOutcome;
    summary: string;
    /** The verdict in a sentence: a fixture's own summary, or Keel's outcome said plainly. */
    said: string;
    issuedAt: string;
    /** Absent for a ruling made at Precheck, before any plan is compiled. */
    planHash?: string;
    evidence: EvidenceItem[];
    /**
     * What the verdict's own event recorded as its evidence, as Keel wrote it. Present where Keel serves no
     * view of the verdict, so there is no evidence by class to show.
     */
    recorded?: string[];
  };
  conflict?: { id: string; label: string; state: ConflictState; with: string; summary: string };
  /**
   * Present when Keel has told this change that others have its intent: their declared effects make the same
   * claims. `others` is in the order Keel named them. Keel never ranks them or picks one, and nor does this.
   */
  sameIntent?: { self: IntentRow; others: AlternativeRow[] };
  /**
   * While it stands bounced: what Keel named as the cause, where that is not a verdict. A change whose plan
   * blocks on a predicate bounces on a conflict proven on it, and one whose batch Artifacts refused to take
   * bounces on that refusal; one a ruling went against bounces on that ruling's decision, and `ruling` names
   * it, the conflict whose resolution names the same decision, and the reasons Keel gave, in its words. No
   * verdict is issued for any of the three. `next` is the ways forward Keel gave its agent.
   */
  bounce?: {
    at: string;
    conflict?: { id: string; label: string; predicate?: string };
    refused?: "pack-too-large" | "repo-bytes-quota";
    ruling?: RulingBounce;
    next: string[];
    /** The decision the bounce cites, by its id, the one Keel's next actions say to read, and by its label. */
    cites?: { id: string; label: string };
  };
  /**
   * Conflicts Keel proved against it and let it go on from: its plan advises or annotates on that predicate.
   * `next` is what Keel told its agent it could do. An annotation tells no one, so it has none.
   */
  noted: {
    conflict: { id: string; label: string };
    predicate: string;
    policy: "advise" | "annotate";
    at: string;
    next: string[];
  }[];
  escalation?: {
    id: string;
    label: string;
    question: string;
    state: "open" | "ruled" | "withdrawn";
    ruling?: string;
  };
  plan: {
    hash: string;
    costEstimateUsd: number;
    steps: PlanStep[];
    /** The compiled flow, as the tree it was written in. Absent until the plan is compiled, or while Keel publishes only a count. */
    spec?: FlowNode;
    /** How many steps the plan has, where that is all Keel has said of it. */
    stepCount?: number;
  };
  /** `state`: Keel has answered with it, has not yet, or would not. Until it is read there are no files to count. */
  diff: {
    state: "reading" | "read" | "refused";
    files: DiffFile[];
    annotations: DiffAnnotation[];
    additions: number;
    deletions: number;
  };
  precedents: {
    decisionId: string;
    decisionLabel: string;
    summary: string;
    decidedAt: string;
    scope: string;
    stance?: string;
  }[];
}
