// The MFP 0.1 shapes the console reads. Keel's propositions, evidence and
// derived effects are MFP's own, and these are Keel's generated wire types
// for them (see ./keel), not a copy written here. Propositions, anchors and
// derived effects are read off events, so they are the events' shapes.

import type * as Keel from "./keel/index.ts";

export type {
  Cost,
  EvidenceClass,
  EvidenceSource,
  FootprintEntry,
  Predicate,
  Relation,
  VerdictOutcome,
} from "./keel/index.ts";
export type Anchor = Keel.EventAnchor;
export type Proposition = Keel.EventProposition;
export type DerivedEffect = Keel.EventDerivedEffect;

/**
 * MFP's Evidence, with the one field decided on 11 Oct 2026 that Keel's contract does not carry yet:
 * `summary`, one sentence from whoever produced it. Keel's producers always set it.
 */
export interface Evidence extends Keel.Evidence {
  summary?: string;
}
