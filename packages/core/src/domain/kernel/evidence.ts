import { Schema } from "effect";

/**
 * How much weight a piece of evidence carries. Only proof and rulings may block
 * or clear a change; testimony and opinion only route work (ADR 0005).
 */
export const EvidenceClass = Schema.Literals(["proof", "ruling", "testimony", "opinion"]);
export type EvidenceClass = typeof EvidenceClass.Type;

const RANK: Record<EvidenceClass, number> = { opinion: 0, testimony: 1, ruling: 2, proof: 3 };

/** The weaker of two classes: what a step that consumed both is worth (taint). */
export function weakest(a: EvidenceClass, b: EvidenceClass): EvidenceClass {
  return RANK[a] <= RANK[b] ? a : b;
}

/** Only proof and rulings may fail or clear a change. */
export function canBlock(evidence: EvidenceClass): boolean {
  return evidence === "proof" || evidence === "ruling";
}
