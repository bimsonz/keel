// Builds Clef requests the way Keel would: structured state, a choice over
// every lattice value plus "unclear", and permuted variants.
//
// The service canonicalises a choice question by sorting option ids (and sorts
// JSON object keys in the state), so reordering the criteria object is a no-op.
// A real permutation has to change the ids: each id carries an ordering
// prefix ("c-per-session"), which sets the position the model sees.
import { LATTICES, UNCLEAR, optionsFor, type Premise } from "./lattice.ts";

export interface Variant {
  name: string;
  order: string[]; // lattice values in the order presented
  idOf: Record<string, string>; // value -> option id
  valueOf: Record<string, string>; // option id -> value
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function shuffled(values: string[], rnd: () => number): string[] {
  const a = [...values];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function variant(name: string, order: string[]): Variant {
  const idOf: Record<string, string> = {};
  const valueOf: Record<string, string> = {};
  order.forEach((v, i) => {
    const id = `${String.fromCharCode(97 + i)}-${v}`;
    idOf[v] = id;
    valueOf[id] = v;
  });
  return { name, order, idOf, valueOf };
}

/** v0: lattice order with unclear last; v1, v2: two distinct seeded shuffles. */
export function variantsFor(itemId: string, premise: Premise): Variant[] {
  const base = optionsFor(premise.predicate);
  const seen = new Set([base.join(",")]);
  const out = [variant("v0", base)];
  const rnd = mulberry32(hash(itemId));
  while (out.length < 3) {
    const order = shuffled(base, rnd);
    if (seen.has(order.join(","))) continue;
    seen.add(order.join(","));
    out.push(variant(`v${out.length}`, order));
  }
  return out;
}

export function question(premise: Premise, v: Variant) {
  const lattice = LATTICES[premise.predicate];
  const criteria: Record<string, string> = {};
  for (const value of v.order) {
    criteria[v.idOf[value]] =
      value === UNCLEAR
        ? `The facts do not determine the ${premise.predicate} of this subject after the change.`
        : lattice.describe[value];
  }
  return {
    type: "choice" as const,
    instructions: {
      task: "Read the change facts (diff hunks and symbols). Choose the value this subject's predicate has after the change is applied. If the change leaves the subject untouched, choose the value it already has.",
      subject: premise.subject,
      predicate: premise.predicate,
      scope: premise.scope,
    },
    criteria,
  };
}

export function stateFor(change: { hunks: unknown[]; symbols: unknown[] }) {
  return { hunks: change.hunks, symbols: change.symbols };
}
