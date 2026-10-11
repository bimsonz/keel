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
import type { ChangeState, ConflictKind, ConflictState, Drift } from "../contract/keel/index.ts";
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
  /** Declared by the agent, or derived by Keel from the diff. */
  origin: "declared" | "derived";
  /** For a derived effect: how, and with what probability if a model said so. */
  derivation?: {
    method: "extractor" | "clef" | "code-model";
    evidenceClass: EvidenceClass;
    p?: number;
  }[];
}

export interface Party {
  /** Its side of the conflict, as Keel names the worlds: A holds the premise, B alters what it relies on. */
  world: "A" | "B";
  changeId: string;
  /** The change's own name, `#n`. */
  label: string;
  goal: string;
  agent: { label: string; class: AgentClass; harness: string };
  proposition: PartyProposition;
  notice: { title: string; nextActions: string[] };
}

export type TestCell = {
  kind: "tests";
  outcome: Outcome | Pending;
  passed?: number;
  total?: number;
  /** Why the check does not apply, for `n/a`. */
  reason?: string;
};

export type ProbeCell = {
  kind: "probe";
  /** Three runs, in order. */
  runs: [Outcome | Pending, Outcome | Pending, Outcome | Pending];
  reason?: string;
  /** True in the control world, where failing is what a working probe does. */
  control?: boolean;
};

/** A check Keel does not run in a world: nothing is drawn there. The control world runs the probe alone. */
export type NoCell = { kind: "none" };

export type MatrixCell = TestCell | ProbeCell | NoCell;

export interface MatrixCheck {
  id: "tests-a" | "tests-b" | "probe";
  label: string;
}

export interface WorldMatrix {
  worlds: { id: World; label: string; gloss: string }[];
  checks: MatrixCheck[];
  cells: Record<World, Record<MatrixCheck["id"], MatrixCell>>;
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
    /** What the two sides hold, in a line. */
    summary: string;
    /** What settling it has cost so far, where Keel has said. */
    costUsd?: number;
  };
  /** The question it was put to a person as, if it was. */
  escalation?: {
    id: string;
    label: string;
    question: string;
    state: "open" | "ruled" | "withdrawn";
  };
  /** What it left behind once proven: the probe, admitted as a guard. */
  guard?: { label: string; state: "admitted" | "retired" };
  /** What a person decided of it. */
  decision?: { label: string; chosen: string };
  subject: { key: string; gloss: string };
  lattice: Lattice;
  parties: { A: Party; B: Party };
  matrix: WorldMatrix;
  /**
   * What came of it: each side that Keel judged again once the conflict was settled, and how. Keel runs nothing
   * in the matrix's worlds after that, so this, and not the matrix, is where a revised change is seen to pass.
   */
  after: { changeId: string; label: string; revision: number; outcome: string; summary: string }[];
  probe: {
    id: string;
    label: string;
    attempt: number;
    bundleHash: string;
    state: "calibrating" | "admitted" | "discarded";
    path: string;
    source: string;
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

export interface ChangePageState {
  change: {
    /** True where the project has verification switched off: its verdict or its landing was not verified. */
    unverified: boolean;
    id: string;
    label: string;
    state: ChangeState;
    revision: number;
    commit: string;
    workspace: string;
    declaredAt: string;
    submittedAt?: string;
    laneLabel?: string;
  };
  agent: { label: string; class: AgentClass; harness: string; model: string };
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
    issuedAt: string;
    /** Absent for a ruling made at Precheck, before any plan is compiled. */
    planHash?: string;
    evidence: EvidenceItem[];
  };
  conflict?: { id: string; label: string; state: ConflictState; with: string; summary: string };
  /**
   * While it stands bounced: the conflict it bounced on, where Keel named one. A project that blocks on a proven
   * conflict bounces the change on the conflict itself, and no verdict is issued for that.
   */
  bounce?: { at: string; conflict?: { id: string; label: string } };
  /** Conflicts Keel proved against it and let it go on from: the project advises or annotates on that predicate. */
  noted: {
    conflict: { id: string; label: string };
    predicate: string;
    policy: "advise" | "annotate";
    at: string;
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
    decisionLabel: string;
    summary: string;
    decidedAt: string;
    scope: string;
    stance?: string;
  }[];
}
