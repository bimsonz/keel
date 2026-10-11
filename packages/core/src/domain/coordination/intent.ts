import { canonicalJson, type Json } from "../kernel/index.ts";
import type { Intent } from "./change.ts";
import type { IntentRevised } from "./events.ts";
import type { Proposition } from "./proposition.ts";

/**
 * What a revision says about the intent it revises: an `IntentRevised`
 * without its tag and change id. The event satisfies it, and so does a
 * revision built from a command before it is decided.
 */
export type IntentRevision = Pick<
  typeof IntentRevised.Type,
  "revision" | "goal" | "footprint" | "premisesAdded" | "premisesRetracted" | "declaredEffects"
>;

const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value));

/** Whether two propositions are the same once canonicalised: never by reference. */
export const sameProposition = (a: Proposition, b: Proposition): boolean =>
  canonicalJson(asJson(a)) === canonicalJson(asJson(b));

/** The premises with every repeat of an earlier one removed, in first-seen order. An intent's premises are a set. */
export const dedupePremises = (premises: readonly Proposition[]): readonly Proposition[] => {
  const seen = new Set<string>();
  return premises.filter((premise) => {
    const key = canonicalJson(asJson(premise));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * The intent a revision leaves: its revision number; the goal, footprint and
 * declared effects it gives, each replacing the old one, or the old ones where
 * it gives none; and the premises still held after its retractions, then the
 * ones it adds, each once. It checks nothing (the Change machine's `evolve`
 * checks the revision follows) and mutates neither argument. The Change
 * machine, the Project DO's live index and the Subject DO all fold a revision
 * with it.
 */
export const reviseIntent = (intent: Intent, revision: IntentRevision): Intent => {
  const kept = intent.premises.filter(
    (premise) =>
      !revision.premisesRetracted.some((retracted) => sameProposition(premise, retracted)),
  );
  return {
    ...intent,
    revision: revision.revision,
    ...(revision.goal === undefined ? {} : { goal: revision.goal }),
    ...(revision.footprint === undefined ? {} : { footprint: revision.footprint }),
    premises: dedupePremises([...kept, ...revision.premisesAdded]),
    ...(revision.declaredEffects === undefined
      ? {}
      : { declaredEffects: revision.declaredEffects }),
  };
};
