// The counters Keel's platform would keep for the review funnel's first four
// stages, which no catalogue event carries. The mock reads
// them off the log it has just written, so they can never disagree with it.
//
// A comparison is one derived effect on a (subject, predicate), checked against
// one distinct premise on that subject or an ancestor of it, held by another
// change, in flight or landed. A landed change's premise stays: the code on
// trunk still relies on it.
//
//   stage 0  subject index   every premise another change holds; it passes on
//                            only the distinct ones on what this change alters
//   stage 1  lattice         settles a comparison when an extractor derived the
//                            effect: inside the premise, or contradicting it
//   stage 2  Clef            where no extractor applies, its asks vote: compatible settles,
//                            a contradiction goes on; for one, it picks the probe's template
//   stage 3  code model      drafts the probe; it settles nothing
//
// Stage 4 (the probe) and stage 5 (a person) are events, and are counted there.

import type { ScriptedEvent } from "./scripted.ts";
import type { Proposition } from "../../../src/contract/mfp.ts";
import type { FunnelObservation, FunnelStageFrame } from "../../../src/contract/observations.ts";

/** What one unit of each stage's work costs in the test fixtures, in dollars. */
export const UNIT_USD = {
  /** One keyed read of a subject's premises. */
  indexLookup: 0.00000015,
  /** One Clef call: every question about one change, asked together. */
  clefCall: 0.00012,
  /** One attempt at drafting a probe. */
  probeDraft: 0.00092,
  /** One run of a probe in one world, in a throwaway isolate. */
  probeRun: 0.000064,
} as const;

export type FunnelFrame = Omit<FunnelObservation, "kind" | "at">;

const keyOf = (proposition: Proposition): string =>
  `${proposition.subject}/${proposition.predicate}`;

/** A (subject, predicate) key and the same predicate on each ancestor subject: `a.b.c`, `a.b`, `a`. */
function withAncestors(key: string): string[] {
  const [subject = "", predicate = ""] = key.split("/");
  const parts = subject.split(".");
  return [...parts.keys()].map(
    (index) => `${parts.slice(0, parts.length - index).join(".")}/${predicate}`,
  );
}
const sayOf = (proposition: Proposition): string =>
  `${proposition.relation} ${String(proposition.value)}`;

/** The premises changes hold, in flight or landed: by (subject, predicate), then by what they say, to who says it. */
class PremiseIndex {
  readonly #byChange = new Map<string, Proposition[]>();
  readonly #byKey = new Map<string, Map<string, Set<string>>>();
  /** Premises held, in all. */
  total = 0;

  held(changeId: string): number {
    return this.#byChange.get(changeId)?.length ?? 0;
  }

  add(changeId: string, premises: readonly Proposition[]): void {
    const own = this.#byChange.get(changeId) ?? [];
    for (const premise of premises) {
      own.push(premise);
      const says = this.#byKey.get(keyOf(premise)) ?? new Map<string, Set<string>>();
      const holders = says.get(sayOf(premise)) ?? new Set<string>();
      holders.add(changeId);
      says.set(sayOf(premise), holders);
      this.#byKey.set(keyOf(premise), says);
      this.total += 1;
    }
    this.#byChange.set(changeId, own);
  }

  /** Drop a change's premises on these (subject, predicate) keys, or all of them. */
  drop(changeId: string, keys?: ReadonlySet<string>): void {
    const own = this.#byChange.get(changeId) ?? [];
    const kept: Proposition[] = [];
    for (const premise of own) {
      if (keys !== undefined && !keys.has(keyOf(premise))) {
        kept.push(premise);
        continue;
      }
      this.#byKey.get(keyOf(premise))?.get(sayOf(premise))?.delete(changeId);
      this.total -= 1;
    }
    if (kept.length === 0) this.#byChange.delete(changeId);
    else this.#byChange.set(changeId, kept);
  }

  /** Each distinct premise on a key, or on an ancestor subject, that someone other than `changeId` holds, with its holders. */
  othersOn(key: string, changeId: string): Set<string>[] {
    const found: Set<string>[] = [];
    for (const place of withAncestors(key)) {
      for (const holders of this.#byKey.get(place)?.values() ?? []) {
        if (holders.size > (holders.has(changeId) ? 1 : 0)) found.push(holders);
      }
    }
    return found;
  }
}

/**
 * The funnel's running totals after each event that moves one, with the
 * index of that event. `events` is the whole log, in order.
 */
export function funnelFrames(
  events: readonly ScriptedEvent[],
): { index: number; frame: FunnelFrame }[] {
  const index = new PremiseIndex();
  const [index0, lattice, clef, model]: [
    FunnelStageFrame,
    FunnelStageFrame,
    FunnelStageFrame,
    FunnelStageFrame,
  ] = [
    { stage: 0, considered: 0, settled: 0, passedOn: 0, usd: 0 },
    { stage: 1, considered: 0, settled: 0, passedOn: 0, usd: 0 },
    { stage: 2, considered: 0, settled: 0, passedOn: 0, usd: 0 },
    { stage: 3, considered: 0, settled: 0, passedOn: 0, usd: 0 },
  ];
  const totals = [index0, lattice, clef, model];
  let changesCompared = 0;
  const frames: { index: number; frame: FunnelFrame }[] = [];

  // An effect does not say what it contradicts; the conflict Keel opens for it does, and that conflict's
  // cause is the derivation that showed it. So for each derivation, the holders it turned out to disagree with.
  const derivations = new Map<string, { at: number; changeId: string }>();
  const disagreesWith = new Map<number, string[]>();
  events.forEach((event, at) => {
    if (event.type === "EffectsDerived")
      derivations.set(event.eventId, { at, changeId: event.payload.changeId });
    else if (event.type === "ConflictSuspected" && event.payload.kind === "semantic") {
      const cause = derivations.get(event.causation ?? "");
      if (cause === undefined) return;
      disagreesWith.set(cause.at, [
        ...(disagreesWith.get(cause.at) ?? []),
        ...event.payload.parties.filter((party) => party !== cause.changeId),
      ]);
    }
  });

  events.forEach((event, at) => {
    switch (event.type) {
      case "IntentDeclared":
        index.add(event.payload.changeId, event.payload.premises);
        return;
      case "IntentRevised":
        index.drop(event.payload.changeId, new Set(event.payload.premisesRetracted.map(keyOf)));
        index.add(event.payload.changeId, event.payload.premisesAdded);
        return;
      // A change that lands keeps its premises: the code on trunk still relies on them.
      case "ChangeWithdrawn":
      case "ChangeSuperseded":
        index.drop(event.payload.changeId);
        return;
      case "EffectsDerived": {
        const { changeId, effects } = event.payload;
        const everyone = index.total - index.held(changeId);
        let narrowed = 0;
        let toClef = 0;
        let clefSettled = 0;
        for (const key of new Set(effects.map((effect) => keyOf(effect.proposition)))) {
          const onKey = effects.filter((effect) => keyOf(effect.proposition) === key);
          const premises = index.othersOn(key, changeId);
          const cited = disagreesWith.get(at) ?? [];
          const contradicted = premises.filter((holders) =>
            cited.some((holder) => holders.has(holder)),
          ).length;
          narrowed += premises.length;
          if (onKey.some((effect) => effect.method === "extractor")) {
            // A derived fact: the lattice rules on it, and only a contradiction goes further.
            lattice.settled += premises.length - contradicted;
            toClef += contradicted;
          } else {
            // An opinion: the lattice may not rule on it, so Clef's own confidence decides.
            toClef += premises.length;
            clefSettled += premises.length - contradicted;
          }
        }
        changesCompared += 1;
        index0.considered += everyone;
        index0.settled += everyone - narrowed;
        index0.passedOn += narrowed;
        index0.usd += UNIT_USD.indexLookup;
        lattice.considered += narrowed;
        lattice.passedOn += toClef;
        clef.considered += toClef;
        clef.settled += clefSettled;
        if (toClef > 0 || effects.some((effect) => effect.method === "clef"))
          clef.usd += UNIT_USD.clefCall;
        break;
      }
      case "ConflictSuspected":
        // Other kinds of conflict are not found by comparing propositions.
        if (event.payload.kind !== "semantic") return;
        clef.passedOn += 1;
        model.considered += 1;
        break;
      case "ProbeDrafted":
        model.passedOn += 1;
        model.usd += UNIT_USD.probeDraft * event.payload.attempts;
        break;
      default:
        return;
    }
    // Sums of fractions of a cent: rounded, so a total reads as what was added up.
    frames.push({
      index: at,
      frame: {
        changesCompared,
        stages: totals.map((total) => ({ ...total, usd: Math.round(total.usd * 1e9) / 1e9 })),
      },
    });
  });
  return frames;
}
