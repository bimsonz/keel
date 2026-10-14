// The shapes the console reads for what Keel says. Keel's propositions and
// derived effects are read off events, so they are the events' shapes, and
// these are Keel's generated wire types for them (see ./keel), not a copy
// written here.

import type * as Keel from "./keel/index.ts";

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
