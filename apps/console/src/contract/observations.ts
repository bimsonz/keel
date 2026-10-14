// PROVISIONAL. Timed facts the console shows that are not catalogue events:
// the review funnel's cheaper levels and aggregate metrics. They form a second
// log beside the events, addressable by time in the same way, so a deep link
// can show "the funnel as of 2:10".

import type { Predicate } from "./mfp.ts";

/** The review funnel's stages, cheapest first. "Stage" on screen, so they never read as execution Tier 0 to 2. */
export type FunnelStage = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * One stage's running totals. A comparison is one derived effect on a
 * (subject, predicate), checked against one distinct premise on that subject
 * or an ancestor of it, held by another change, in flight or landed.
 */
export interface FunnelStageFrame {
  stage: FunnelStage;
  /** Comparisons that reached this stage. */
  considered: number;
  /** Comparisons this stage settled, so they went no further. */
  settled: number;
  /** Comparisons it handed on. What is neither settled nor passed on is still here. */
  passedOn: number;
  usd: number;
}

/**
 * B5: running totals for stages 0 to 3, which no event counts. Keel sends it as
 * a metrics frame on the observer stream, and serves it at `GET /v1/views/funnel`.
 */
export interface FunnelObservation {
  kind: "funnel";
  at: string;
  /** Derivations so far. Each is one submitted change compared against every premise other changes hold. */
  changesCompared: number;
  stages: FunnelStageFrame[];
}

/** B10: counters only the platform can know, sampled once a second. */
export interface MetricsObservation {
  kind: "metrics";
  at: string;
  syntheticIntents: number;
  preflightP50Ms: number;
  preflightP99Ms: number;
}

/** B9: what ranks a bet. */
export interface BetObservation {
  kind: "bet";
  at: string;
  subjectKey: string;
  predicate: string;
  holders: number;
  blastRadius: number;
  probeCostUsd: number;
}

/**
 * H1: one disagreement the swarm's runner arranged, or one decoy made to look
 * like one. The runner names the agents it instructed; it cannot know, before
 * the run, which changes they will declare.
 */
export interface ManifestEntry {
  id: string;
  kind: "planted" | "decoy";
  subject: string;
  predicate: Predicate;
  /** The agent told to rely on the subject, and the most it was told to tolerate. */
  relies: { agent: string; atMost: string };
  /** The agent told to change it, and what its change really makes it. For a decoy that is inside the premise. */
  alters: { agent: string; to: string };
}

/** H1: the runner commits to its ground truth before the run. This is the runner's, not Keel's: Keel never sees it. */
export interface SealObservation {
  kind: "seal";
  at: string;
  /** How the run was started, so it can be run again. */
  runner: string;
  /** `sha256:` and the digest of the text the runner will publish at the unsealing. */
  commitment: string;
  planted: number;
  decoys: number;
}

/** H1: the runner publishes what it sealed, and which changes its agents went on to declare. */
export interface UnsealObservation {
  kind: "unseal";
  at: string;
  /** The exact text that was hashed: a salt, a newline, then the entries as JSON. */
  sealed: string;
  /** For each entry, by id: the two changes, as the runner saw them. Not sealed, so the console checks them against the log. */
  changes: Record<string, { relies: string; alters: string }>;
}

export type Observation =
  | FunnelObservation
  | MetricsObservation
  | BetObservation
  | SealObservation
  | UnsealObservation;
