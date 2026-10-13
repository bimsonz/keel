// What a change's page says of Keel's verdict on it, and of what Keel derived from its commit, in Keel's own
// fields. Keel's event for a verdict carries an outcome, whether a plan ran, and the evidence it recorded; it
// carries no sentence of its own, so the page words one from the outcome and adds nothing to it.

import type { ChangeState, VerdictOutcome } from "../contract/keel/index.ts";

const TO: Record<VerdictOutcome, string> = {
  land: "land it",
  bounce: "bounce it",
  park: "park it",
  hold: "hold it",
  supersede: "supersede it",
};

/** The states a change does not leave: Keel issues nothing more for one that is over. */
const OVER: ReadonlySet<ChangeState> = new Set(["landed", "withdrawn", "superseded"]);

/**
 * A verdict, in a sentence. A fixture's verdict has a summary and is said in it. Keel's own has none: it is
 * said by its outcome, and where Keel issued it with no plan run, because the project's verification is off,
 * that is said too.
 */
export function verdictSaid(verdict: {
  summary: string;
  outcome: VerdictOutcome;
  unverified: boolean;
}): string {
  if (verdict.summary !== "") return `${verdict.summary}.`;
  return `Keel's verdict was to ${TO[verdict.outcome]}${verdict.unverified ? ", without verification" : ""}.`;
}

/**
 * What the page says of a change Keel has issued no verdict for. One still on its way may be given one yet; one
 * that is over never will be.
 */
export function unjudged(state: ChangeState): string {
  return OVER.has(state)
    ? `The change is ${state}. Keel issued no verdict for it.`
    : `The change is ${state}. Keel has not issued a verdict yet.`;
}

/**
 * What stands where Keel's derived effects would be listed and there are none: the change pushed no commit to
 * derive from, Keel has not derived from the one it pushed yet, or it has and found no effect.
 */
export function noneDerived(change: { commit: string; derived: boolean }): string {
  if (change.commit === "") return "This change pushed no commit, so Keel derived nothing.";
  return change.derived
    ? "Keel derived no effect from this commit."
    : "Keel has not derived what this commit does yet.";
}
