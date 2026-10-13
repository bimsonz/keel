/**
 * A fold's from-table, checked from outside the fold. A machine's
 * `decide-evolvable` property proves its fold takes what its decide emits, and
 * says nothing of what the fold must refuse. Here the states are the ones a
 * tour of the real machine reaches, the events are the ones that tour
 * committed, each in every form the fold could tell apart, and the table that
 * says where each lands is typed apart from the fold.
 */
import {
  canonicalJson,
  type Committed,
  IllegalTransition,
  type Instant,
  type Json,
} from "../../src/domain/kernel/index.ts";
import type { Fold } from "./machine.ts";

export interface FoldTable<S, E, F> {
  readonly evolve: (state: S | undefined, event: Committed<E>) => S;
  /** A tour of the machine: the states a run reaches and the events it commits. */
  readonly walked: readonly Fold<S, E>[];
  /** What the table is about, read from a state: two states with the same line are one row. */
  readonly summary: (state: S) => F;
  readonly shown: (folded: F) => string;
  /** An event in every form the fold could tell apart, the committed one among them. */
  readonly forms: (event: E) => readonly E[];
  /** The instants an event is folded at: each is a case of its own. */
  readonly times: readonly Instant[];
  /** Where the event lands from `from`, or that the fold must refuse it. */
  readonly table: (from: F | undefined, event: E, at: Instant) => F | "illegal";
  /**
   * Which row a state stands for, when a tour reaches more states than a table
   * can cross: the first state of each row is the one tried. Defaults to the
   * state's own line, so every distinct summary is a row.
   */
  readonly row?: (state: S | undefined) => string;
  /**
   * Whether a committed event is worth folding into a row, in all its forms.
   * Defaults to every event. A machine whose tour commits thousands narrows it
   * to the events that name something the row holds, and one of each kind.
   */
  readonly meets?: (state: S | undefined, event: E) => boolean;
  /** At most this many events of each kind meet a row: the first in the tour's order. */
  readonly most?: number;
}

/** One fold tried: the row, the event, what the fold did and what the table says. */
export interface FoldCase {
  readonly from: string;
  readonly event: string;
  readonly folded: string;
  readonly table: string;
}

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));

/** Every row by every event form at every instant, the fold's answer beside the table's. */
export const foldCases = <S, E extends { readonly _tag: string }, F>(
  t: FoldTable<S, E, F>,
): readonly FoldCase[] => {
  const line = (state: S | undefined): string =>
    state === undefined ? "none" : t.shown(t.summary(state));
  const row = t.row ?? line;
  const rows = new Map<string, S | undefined>([[row(undefined), undefined]]);
  for (const { before, after } of t.walked)
    for (const state of [before, after]) if (!rows.has(row(state))) rows.set(row(state), state);
  const committed = new Map<string, E>();
  for (const { event } of t.walked) committed.set(canonicalJson(asJson(event)), event);

  const cases: FoldCase[] = [];
  for (const state of rows.values()) {
    const from = line(state);
    const events = new Map<string, E>();
    const met = new Map<string, number>();
    for (const event of committed.values()) {
      if (t.meets !== undefined && !t.meets(state, event)) continue;
      const count = met.get(event._tag) ?? 0;
      if (t.most !== undefined && count >= t.most) continue;
      met.set(event._tag, count + 1);
      for (const form of t.forms(event)) events.set(canonicalJson(asJson(form)), form);
    }
    for (const [printed, event] of events)
      for (const at of t.times) {
        let folded: string;
        try {
          folded = line(t.evolve(state, { at, payload: event }));
        } catch (error) {
          folded = error instanceof IllegalTransition ? "illegal" : `threw ${String(error)}`;
        }
        const said = t.table(state === undefined ? undefined : t.summary(state), event, at);
        cases.push({
          from,
          event: `${printed} at ${at}`,
          folded,
          table: said === "illegal" ? "illegal" : t.shown(said),
        });
      }
  }
  return cases;
};

/** The cases as lines, the fold's and the table's, to compare whole. */
export const foldLines = (
  cases: readonly FoldCase[],
): { readonly folded: readonly string[]; readonly table: readonly string[] } => ({
  folded: cases.map((c) => `${c.from} + ${c.event}: ${c.folded}`),
  table: cases.map((c) => `${c.from} + ${c.event}: ${c.table}`),
});

/** How many folds were tried, how many the table refuses, and the rows they were tried from. */
export const foldShape = (
  cases: readonly FoldCase[],
): { readonly folds: number; readonly refused: number; readonly rows: readonly string[] } => ({
  folds: cases.length,
  refused: cases.filter((c) => c.table === "illegal").length,
  rows: [...new Set(cases.map((c) => c.from))],
});
