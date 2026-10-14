// The shapes the console reads for what Keel says. Keel's propositions and
// derived effects are read off events, so they are the events' shapes, and
// these are Keel's generated wire types for them (see ./keel), not a copy
// written here. MFP 0.2 carries no evidence, cost or evidence source: who
// vouches for a claim, and how strongly, is Keel's own record around the
// message, so the console holds those shapes itself, with Keel's evidence class.

import type * as Keel from "./keel/index.ts";
import type { EvidenceClass } from "./keel/index.ts";

export type {
  EvidenceClass,
  FootprintEntry,
  Predicate,
  Relation,
  VerdictOutcome,
} from "./keel/index.ts";
export type Anchor = Keel.EventAnchor;
export type Proposition = Keel.EventProposition;
export type DerivedEffect = Keel.EventDerivedEffect;

/** Where a piece of evidence came from: a separate axis from its class. */
export type EvidenceSource = "source" | "tool-result" | "prior-record" | "external" | "reasoning";

/** A piece of evidence as the console shows it: its class in Keel's own terms, what it refers to, and when. */
export interface Evidence {
  class: EvidenceClass;
  source?: EvidenceSource;
  /** A reference to the evidence itself: a probe run, a test result, a message. */
  ref: string;
  at: string;
  scope?: string;
  /** One sentence from whoever produced it. */
  summary?: string;
}

/** What a step or a call cost. */
export interface Cost {
  /** Wall-clock milliseconds. */
  ms?: number;
  /** Model tokens consumed. */
  tokens?: number;
  /** Spend in US dollars. */
  usd?: number;
}
