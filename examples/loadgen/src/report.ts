import type { KeelClient } from "@keeltown/sdk";

/**
 * A run's numbers, all from Keel's own record of the project: the events the
 * run's changes caused, read back after it. Nothing here is the agents' own
 * account of what they did.
 */

export type KeelEvent = Awaited<ReturnType<KeelClient["events"]>>["items"][number];

export interface LoadReport {
  readonly agents: number;
  readonly declared: number;
  readonly landed: number;
  readonly bounces: number;
  readonly notLanded: number;
  /** The share of declared changes with at least one neighbour on a subject. */
  readonly contentionDensity: number | null;
  /** Bounces per landing. */
  readonly reworkRate: number | null;
  /** From a change's last queueing (or submission) to its landing. */
  readonly queueMs: { readonly p50: number | null; readonly p95: number | null };
  /** The declare call, which answers with the preflight, as the agent waited for it. */
  readonly preflightMs: { readonly p50: number | null; readonly p99: number | null };
  /** The Trunk's own numbers, over the run's promotions: the one serial writer. */
  readonly trunk: {
    readonly promotions: number;
    readonly promotionsPerSecond: number | null;
    readonly changesPerGroupCommit: { readonly mean: number | null; readonly max: number };
    /** From a batch's forming to its candidate's promotion. */
    readonly promotionMs: { readonly p50: number | null; readonly p95: number | null };
  };
}

/** The nearest-rank percentile of `values`, or null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);
const ms = (e: KeelEvent) => Date.parse(e.at);
const changeOf = (e: KeelEvent): string | undefined => {
  const id: unknown = Reflect.get(e.payload, "changeId");
  return typeof id === "string" ? id : undefined;
};

/** The run's numbers from the project's events, for the changes the run's agents declared. */
export function summarise(
  events: readonly KeelEvent[],
  changes: ReadonlySet<string>,
  agents: number,
  declareMs: readonly number[],
): LoadReport {
  const mine = events.filter((e) => {
    const id = changeOf(e);
    return id !== undefined && changes.has(id);
  });
  const tagged = (tag: string) => mine.filter((e) => e.payload._tag === tag);
  const declaredAt = new Map<string, number>();
  for (const e of tagged("IntentDeclared")) {
    const id = changeOf(e);
    if (id !== undefined && !declaredAt.has(id)) declaredAt.set(id, ms(e));
  }
  const landings = tagged("ChangeLanded");
  const landedIds = new Set(landings.flatMap((e) => changeOf(e) ?? []));
  const bounces = tagged("ChangeBounced").length;

  const neighboured = new Set(
    tagged("PreflightIssued").flatMap((e) =>
      e.payload._tag === "PreflightIssued" &&
      e.payload.neighbours.some((n) => n.overlap === "subject")
        ? [e.payload.changeId]
        : [],
    ),
  );
  // Queue: from the last queueing (or, failing that, submission) before each landing.
  const queue = landings.flatMap((landing) => {
    const id = changeOf(landing);
    const before = mine.filter(
      (e) =>
        changeOf(e) === id &&
        ms(e) <= ms(landing) &&
        (e.payload._tag === "ChangeQueued" || e.payload._tag === "ChangeSubmitted"),
    );
    const queued = before.findLast((e) => e.payload._tag === "ChangeQueued") ?? before.at(-1);
    return queued === undefined ? [] : [ms(landing) - ms(queued)];
  });

  // The Trunk: the candidates the run's changes landed in, and the batches they were formed from.
  const perCandidate = new Map<string, number>();
  for (const e of landings)
    if (e.payload._tag === "ChangeLanded")
      perCandidate.set(e.payload.candidateId, (perCandidate.get(e.payload.candidateId) ?? 0) + 1);
  const promoted = events.filter(
    (e) => e.payload._tag === "CandidatePromoted" && perCandidate.has(e.payload.candidateId),
  );
  const formedAt = new Map<string, number>();
  for (const e of events)
    if (e.payload._tag === "BatchFormed" && !formedAt.has(e.payload.batchId))
      formedAt.set(e.payload.batchId, ms(e));
  const promotion = promoted.flatMap((e) => {
    const from =
      e.payload._tag === "CandidatePromoted" ? formedAt.get(e.payload.batchId) : undefined;
    return from === undefined ? [] : [ms(e) - from];
  });
  const start = Math.min(...declaredAt.values());
  const end = Math.max(...promoted.map(ms));
  const sizes = [...perCandidate.values()];

  return {
    agents,
    declared: declaredAt.size,
    landed: landedIds.size,
    bounces,
    notLanded: declaredAt.size - landedIds.size,
    contentionDensity: ratio(
      [...declaredAt.keys()].filter((id) => neighboured.has(id)).length,
      declaredAt.size,
    ),
    reworkRate: ratio(bounces, landedIds.size),
    queueMs: { p50: percentile(queue, 50), p95: percentile(queue, 95) },
    preflightMs: { p50: percentile(declareMs, 50), p99: percentile(declareMs, 99) },
    trunk: {
      promotions: promoted.length,
      promotionsPerSecond:
        promoted.length === 0 || !(end > start) ? null : promoted.length / ((end - start) / 1000),
      changesPerGroupCommit: {
        mean: ratio(
          sizes.reduce((a, b) => a + b, 0),
          sizes.length,
        ),
        max: Math.max(0, ...sizes),
      },
      promotionMs: { p50: percentile(promotion, 50), p95: percentile(promotion, 95) },
    },
  };
}

/** A proposition as Keel compares it: subject, predicate, relation and value. */
const said = (p: unknown) =>
  JSON.stringify(
    ["subject", "predicate", "relation", "value"].map((k) => Reflect.get(Object(p), k)),
  );

/**
 * Where Keel tied two changes together, each pair once: a suspected or noted
 * conflict with both as parties, a premise suspected because of the other, a
 * bounce on a conflict with the other, or a preflight contradiction between
 * one's premise and a proposition the other holds. A contradiction names the
 * premise's holder; the proposition against it is matched to the change Keel
 * recorded holding it (its `PremiseRelied` or `EffectsDerived`). A neighbour
 * alone never ties two: footprint overlap is exposure.
 */
export function ties(events: readonly KeelEvent[]): ReadonlySet<string> {
  const tied = new Set<string>();
  const tie = (x: string, y: string) => {
    if (x !== y) tied.add(tieKey(x, y));
  };
  const parties = new Map<string, Set<string>>();
  const join = (conflictId: string, changeId: string) => {
    const held = parties.get(conflictId) ?? new Set<string>();
    held.add(changeId);
    parties.set(conflictId, held);
  };
  const holders = new Map<string, Set<string>>();
  const holds = (proposition: unknown, changeId: string) => {
    const at = holders.get(said(proposition)) ?? new Set<string>();
    at.add(changeId);
    holders.set(said(proposition), at);
  };
  for (const e of events) {
    const p = e.payload;
    if (p._tag === "PremiseRelied") holds(p.premise, p.changeId);
    else if (p._tag === "EffectsDerived")
      for (const effect of p.effects) holds(Reflect.get(Object(effect), "proposition"), p.changeId);
  }
  for (const e of events) {
    const p = e.payload;
    if (p._tag === "ConflictSuspected") for (const party of p.parties) join(p.conflictId, party);
    else if (p._tag === "ConflictNoted") join(p.conflictId, p.changeId);
    else if (p._tag === "ChangeBounced" && p.conflictId !== undefined)
      join(p.conflictId, p.changeId);
    else if (p._tag === "PremiseSuspected") tie(p.changeId, p.cause.changeId);
    else if (p._tag === "PreflightIssued")
      for (const c of p.contradictions) {
        tie(p.changeId, c.holder);
        if (c.holder === p.changeId)
          for (const other of holders.get(said(c.with)) ?? []) tie(p.changeId, other);
      }
  }
  for (const held of parties.values()) {
    const ids = [...held];
    for (const x of ids) for (const y of ids) tie(x, y);
  }
  return tied;
}

export const tieKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
