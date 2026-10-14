import { BENCH_KINDS, type BenchKind, type PairKey } from "./plan.ts";
import { tieKey } from "./report.ts";

/** 07's go/no-go: planted conflicts found, and decoys left alone. */
export const BARS = { recall: 0.7, falsePositiveRate: 0.2 } as const;

export interface KindScore {
  readonly planted: number;
  readonly recalled: number;
  readonly decoys: number;
  readonly falsePositives: number;
}

export interface BenchScore {
  readonly byKind: Readonly<Record<BenchKind, KindScore>>;
  /** Pairs left out because a side never declared: Keel was never shown them. */
  readonly unrun: number;
  readonly recall: number | null;
  readonly falsePositiveRate: number | null;
  readonly passes: { readonly recall: boolean; readonly decoys: boolean };
}

const zero = () => ({ planted: 0, recalled: 0, decoys: 0, falsePositives: 0 });

/**
 * Scores the sealed key against what Keel reported: a planted pair is
 * recalled when Keel tied its two changes together, and a decoy is a false
 * positive when it did.
 */
export function score(
  key: readonly PairKey[],
  changeOf: (index: number) => string | undefined,
  tied: ReadonlySet<string>,
): BenchScore {
  const byKind: Record<BenchKind, ReturnType<typeof zero>> = {
    premise: zero(),
    effect: zero(),
    textual: zero(),
    interaction: zero(),
  };
  let unrun = 0;
  for (const pair of key) {
    const a = changeOf(pair.a);
    const b = changeOf(pair.b);
    if (a === undefined || b === undefined) {
      unrun += 1;
      continue;
    }
    const isTied = tied.has(tieKey(a, b));
    const counts = byKind[pair.kind];
    if (pair.planted) {
      counts.planted += 1;
      if (isTied) counts.recalled += 1;
    } else {
      counts.decoys += 1;
      if (isTied) counts.falsePositives += 1;
    }
  }
  const all = BENCH_KINDS.map((kind) => byKind[kind]);
  const sum = (f: (k: KindScore) => number) => all.reduce((n, k) => n + f(k), 0);
  const planted = sum((k) => k.planted);
  const decoys = sum((k) => k.decoys);
  const recall = planted === 0 ? null : sum((k) => k.recalled) / planted;
  const falsePositiveRate = decoys === 0 ? null : sum((k) => k.falsePositives) / decoys;
  return {
    byKind,
    unrun,
    recall,
    falsePositiveRate,
    passes: {
      recall: recall !== null && recall >= BARS.recall,
      decoys: falsePositiveRate !== null && falsePositiveRate <= BARS.falsePositiveRate,
    },
  };
}
