// PROVISIONAL. Nothing in this file is in Keel's catalogue or API yet.
//
// Each shape here answers a question in QUESTIONS.md with the console's best
// guess, so the views can be built before the contract settles. The mock is
// The mock is the only producer. When Keel settles a question, the shape
// moves into events.ts (or is deleted) and its QUESTIONS.md entry closes.

import type { Cost, Evidence, EvidenceClass } from "./mfp.ts";

/** MFP's Evidence, and two things the console shows when it has them that MFP does not carry. */
export interface EvidenceLine extends Evidence {
  /** What produced it: a probe, an extractor, the lattice, Clef, an agent. */
  by?: string;
  detail?: string;
}

export type StepKind =
  | "deterministic"
  | "decision-model"
  | "generative"
  | "probe"
  | "human"
  | "deploy";

/** QUESTIONS A1: one leaf of a compiled Verification Plan. */
export interface StepSpec {
  id: string;
  title: string;
  kind: StepKind;
  /** Human steps run nowhere. */
  tier: 0 | 1 | 2 | null;
  tierReason: string;
  evidenceCeiling: EvidenceClass;
  /** Why this step exists for this change, and what it cites. */
  because: { text: string; cites?: string };
}

/** QUESTIONS A1: the flow grammar, as a tree. */
export type FlowNode =
  | { op: "step"; step: StepSpec }
  | { op: "seq"; of: FlowNode[] }
  | { op: "par"; of: FlowNode[] }
  | { op: "cascade"; of: FlowNode[] }
  | { op: "worlds"; over: ("trunk" | "A" | "B" | "AB")[]; of: FlowNode }
  | { op: "when"; predicate: string; of: FlowNode }
  | { op: "budget"; usd: number; of: FlowNode };

export type PlanSpec = FlowNode;

/**
 * What rides in `payload.x` of each event type, beside the catalogue's own
 * fields. Keyed by event type; the comment names the question it answers.
 */
export interface ProvisionalFields {
  /** B8: the goal an alternative competes for. */
  IntentDeclared: { alternativeOf?: string };
  /** Whether the effect was one its agent did not declare, against a premise still live. */
  ConflictSuspected: { silentRetraction?: boolean };
  /** B4: what the run cost, and why it did not apply when the outcome is n/a. */
  ProbeRan: { cost?: Cost; reason?: string };
  /** B4: Keel records no cost yet, so there may be none. */
  ConflictProven: { cost?: Cost };
  /** B4 */
  ConflictDismissed: { cost?: Cost };
  /** A3, B4 */
  VerdictIssued: { summary: string; cost?: Cost };
  /** The question it answered, for a decision whose escalation is not in the log being read. */
  DecisionRecorded: { question: string };
  /** E2 */
  TenetEstablished: { label: string };
  /** B7: what belief-aware batching kept out of this batch. */
  BatchFormed: {
    label: string;
    heldApart: {
      changeId: string;
      with: string;
      reason: "open-conflict" | "opposite-effects" | "risky";
    }[];
  };
  /** B6: which members landed by commutation. */
  TrunkAdvanced: {
    commuted: {
      changeId: string;
      verifiedAtHeight: number;
      conditions: ("C1" | "C2" | "C3" | "C4" | "C5" | "C6")[];
    }[];
  };
}

/** QUESTIONS R5: why a line is as it is. It waits on `why`, which Keel does not serve yet. */
export interface RepoNote {
  /** The lines it is about, first and last, counted from 1. */
  from: number;
  to: number;
  /** The subject those lines anchor. */
  subject: string;
  kind: "premise" | "tenet" | "guard" | "decision";
  /** Keel's short name for the tenet, guard or decision. */
  label?: string;
  summary: string;
  /** For a premise: the change that holds it. */
  holder?: { changeId: string; label: string };
}

export interface RepoNotes {
  path: string;
  ref: string;
  notes: RepoNote[];
}
