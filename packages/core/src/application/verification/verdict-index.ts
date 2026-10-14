import { Effect, Option, Schema } from "effect";
import type { EvidenceClass, VerdictId } from "../../domain/kernel/index.ts";
import { type PlanStep, VerdictIssued, VerdictNotFound } from "../../domain/verification/index.ts";
import { feedEntry, feedHead, storedAt } from "../memory/feed.ts";
import { EntityStore, type IndexedVerdict } from "../ports/index.ts";
import { CITED_AS } from "./verify-candidate.ts";

type Store = (typeof EntityStore)["Service"];

/**
 * The verdict index, kept beside the feed it indexes: each VerdictIssued's
 * position in the feed by its verdict's id, and the position the index is
 * complete to. The feed holds every event the Projector received, so a verdict
 * issued before the index existed is found once the index walks past it.
 */
export const VERDICT_INDEX = {
  at: "verdict-at",
  indexed: { kind: "verdict-indexed", id: "self" },
} as const;

/** The feed positions one step of the index reads at most: never one long transaction. */
export const VERDICT_INDEX_STEP = 5_000;

/** The steps a read that misses takes at most, before it answers from what is indexed. */
export const VERDICT_READ_STEPS = 4;

const indexedTo = (store: Store): number => {
  const to = store.get(VERDICT_INDEX.indexed.kind, VERDICT_INDEX.indexed.id);
  return typeof to === "number" ? to : 0;
};

/** A stored feed entry's verdict id, read without decoding the whole event: only a VerdictIssued has one. */
const verdictOf = (stored: unknown): string | undefined => {
  if (stored === null || typeof stored !== "object") return undefined;
  if (Reflect.get(stored, "type") !== "VerdictIssued") return undefined;
  const payload: unknown = Reflect.get(stored, "payload");
  const id: unknown =
    payload !== null && typeof payload === "object" ? Reflect.get(payload, "verdictId") : undefined;
  return typeof id === "string" ? id : undefined;
};

/**
 * Moves the verdict index one step along the feed from its own marker, at
 * most `step` positions, and answers whether it is now level with the feed's
 * head. Run by the Projector's alarm until level, and by a read that misses.
 * Never on a receipt: what arrives is indexed on the next step. It writes, so
 * it runs inside a transaction.
 */
export function indexVerdicts(
  store: Store,
  step: number = VERDICT_INDEX_STEP,
): { readonly to: number; readonly level: boolean } {
  const from = indexedTo(store);
  const head = feedHead(store);
  const to = Math.min(head, from + step);
  for (let at = from + 1; at <= to; at += 1) {
    const verdictId = verdictOf(storedAt(store, at));
    if (verdictId !== undefined) store.put(VERDICT_INDEX.at, verdictId, at);
  }
  if (to > from) store.put(VERDICT_INDEX.indexed.kind, VERDICT_INDEX.indexed.id, to);
  return { to, level: to >= head };
}

/** Whether the verdict index is level with the feed's head: nothing the feed holds is left to walk. */
export const verdictsIndexed = (store: Store): boolean => indexedTo(store) >= feedHead(store);

const decodeVerdict = Schema.decodeUnknownOption(VerdictIssued);

/**
 * One verdict, by its id alone. A verdict the index has not reached yet is
 * looked for by moving the index on, at most VERDICT_READ_STEPS steps; one it
 * still has not found is VerdictNotFound.
 */
export const getVerdict: (
  verdictId: VerdictId,
) => Effect.Effect<IndexedVerdict, VerdictNotFound, EntityStore> = Effect.fn(
  "verification/getVerdict",
)(function* (verdictId: VerdictId) {
  const store = yield* EntityStore;
  const found = store.transaction((): IndexedVerdict | undefined => {
    const lookup = () => store.get(VERDICT_INDEX.at, verdictId);
    let at = lookup();
    for (let steps = 0; at === undefined && steps < VERDICT_READ_STEPS; steps += 1) {
      const { level } = indexVerdicts(store);
      at = lookup();
      if (level) break;
    }
    const entry = typeof at === "number" ? feedEntry(store, at) : undefined;
    const project = entry?.project;
    if (entry === undefined || project === undefined) return undefined;
    return Option.match(decodeVerdict(entry.payload), {
      onNone: () => undefined,
      onSome: (verdict) =>
        verdict.verdictId === verdictId ? { verdict, project, issuedAt: entry.at } : undefined,
    });
  });
  return found ?? (yield* new VerdictNotFound({ verdictId }));
});

/** One line of a verdict's evidence, with the plan step it names and that step's class. */
export interface VerdictReason {
  readonly line: string;
  readonly step?: string;
  readonly class: EvidenceClass;
}

/**
 * The plan step a line of a verdict's evidence names: a result's line opens
 * with its step's id and a colon, and a guard's citation names its step after
 * its heading, before the predicate. No line can name two steps.
 */
const namedStep = (line: string, steps: readonly PlanStep[]): PlanStep | undefined =>
  steps.find(
    (s) => line.startsWith(`${s.id}: `) || line.startsWith(`${CITED_AS.guard.line}: ${s.id} (`),
  );

/**
 * A verdict's evidence, line by line, as it was issued: each classed by the
 * plan step it names (the class its evidence carries after taint, or its
 * ceiling), and a line that names no step, or a verdict with no plan, as
 * proof, since a verifier reports only what ran.
 */
export const verdictReasons = (
  evidence: readonly string[],
  steps: readonly PlanStep[],
): readonly VerdictReason[] =>
  evidence.map((line) => {
    const step = namedStep(line, steps);
    return step === undefined
      ? { line, class: "proof" }
      : { line, step: step.id, class: step.effectiveClass ?? step.evidenceCeiling };
  });
