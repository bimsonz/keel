import { Result, Schema } from "effect";
import {
  canonicalProposition,
  declaredEffect,
  fallout,
  isAncestorOrSelf,
  PremiseSuspected,
  Proposition,
  sameProposition,
  type SubjectKey,
} from "../../domain/coordination/index.ts";
import {
  canonicalJson,
  type ChangeId,
  ConflictId,
  type EntityRef,
  type Instant,
  type ProjectId,
  type SubjectId,
} from "../../domain/kernel/index.ts";
import type { EventDraft, Transaction } from "../ports/index.ts";
import { hashedIdBody } from "./hashed-id.ts";
import { suspectDrafts } from "./probe-ledger.ts";

/** One change's premise and another change's declared effect: what fallout judges. */
export interface FalloutPair {
  readonly premise: { readonly holder: ChangeId; readonly proposition: Proposition };
  readonly effect: { readonly changeId: ChangeId; readonly proposition: Proposition };
}

/** What a subject holds of one change: its premises and declared effects at or under the key. */
export interface HeldBy {
  readonly changeId: ChangeId;
  readonly premises: readonly Proposition[];
  readonly declaredEffects: readonly Proposition[];
}

/** Each pair is judged once, by the subject that judges it: its row, by the pair's identity. */
export const FALLOUT_JUDGED = "fallout-judged";

/** The Probe Workflow, started by the fan-out for each conflict a subject opens. */
export const PROBE_WORKFLOW = "workflow:Probe";

/**
 * Whether the subject at `key` judges a premise on `premiseSubject` against an
 * effect on `effectSubject`: one is the other or its ancestor, and the shorter
 * of the two is `key`. That subject holds both, and it is the only one that
 * judges them; siblings never meet.
 */
export const judgedHere = (
  key: SubjectKey,
  premiseSubject: SubjectKey,
  effectSubject: SubjectKey,
): boolean =>
  isAncestorOrSelf(premiseSubject, effectSubject)
    ? premiseSubject === key
    : isAncestorOrSelf(effectSubject, premiseSubject) && effectSubject === key;

/** The propositions `now` holds that `was` did not. */
const fresh = (now: readonly Proposition[], was: readonly Proposition[]) =>
  now.filter((p) => !was.some((q) => sameProposition(q, p)));

/**
 * The pairs a change's declare or revision brings to the subject at `key`:
 * its new declared effects against every other change's premises, and its new
 * premises against every other change's declared effects, those judged here.
 * Whichever side arrives second brings the pair, so a race judges it once.
 */
export function falloutPairs(
  key: SubjectKey,
  change: { readonly changeId: ChangeId; readonly before: HeldBy; readonly after: HeldBy },
  others: readonly HeldBy[],
): readonly FalloutPair[] {
  const effects = fresh(change.after.declaredEffects, change.before.declaredEffects);
  const premises = fresh(change.after.premises, change.before.premises);
  const pairs: FalloutPair[] = [];
  for (const other of others) {
    if (other.changeId === change.changeId) continue;
    for (const effect of effects)
      for (const premise of other.premises)
        pairs.push({
          premise: { holder: other.changeId, proposition: premise },
          effect: { changeId: change.changeId, proposition: effect },
        });
    for (const premise of premises)
      for (const effect of other.declaredEffects)
        pairs.push({
          premise: { holder: change.changeId, proposition: premise },
          effect: { changeId: other.changeId, proposition: effect },
        });
  }
  return pairs.filter((pair) =>
    judgedHere(key, pair.premise.proposition.subject, pair.effect.proposition.subject),
  );
}

/** A proposition as plain JSON, in canonical form: an ordering named from either end is one claim. */
const encodeClaim = Schema.encodeSync(Schema.toCodecJson(Proposition));
const claimOf = (proposition: Proposition) => encodeClaim(canonicalProposition(proposition));

/** A pair's identity: the same whichever of its sides arrived first. */
const pairKey = (pair: FalloutPair): string =>
  canonicalJson({
    holder: pair.premise.holder,
    premise: claimOf(pair.premise.proposition),
    changeId: pair.effect.changeId,
    effect: claimOf(pair.effect.proposition),
  });

/** The conflict a pair opens: derived from the project and the pair, so a race opens one. */
export const conflictIdOf = (projectId: ProjectId, pair: FalloutPair): ConflictId =>
  ConflictId.make(`cfl_${hashedIdBody(`${projectId}\n${pairKey(pair)}`)}`);

const changeRef = (changeId: ChangeId): EntityRef => ({ kind: "change", id: changeId });
const payloadOf = (encoded: unknown): EventDraft["payload"] => JSON.parse(JSON.stringify(encoded));

/**
 * Judges each pair not judged before, inside the reaction's transaction, with
 * the domain's `fallout` (a declared effect is the agent's own claim):
 * - a conflict opens one on `conflict:<cid>` (ConflictSuspected, its row, its
 *   parties subscribed) and subscribes the Probe Workflow to start on it;
 * - a suspicion tells the premise's holder with PremiseSuspected;
 * - a notice is not committed.
 * A suspicion the conflict machine refuses is a problem for the caller to log.
 */
export function judgeFallout(
  tx: Pick<Transaction, "store" | "outbox">,
  at: Instant,
  subject: { readonly projectId: ProjectId; readonly key: SubjectKey; readonly id: SubjectId },
  pairs: readonly FalloutPair[],
): { readonly drafts: readonly EventDraft[]; readonly problems: readonly string[] } {
  const drafts: EventDraft[] = [];
  const problems: string[] = [];
  for (const pair of pairs) {
    const judged = hashedIdBody(pairKey(pair));
    if (tx.store.get(FALLOUT_JUDGED, judged) !== undefined) continue;
    tx.store.put(FALLOUT_JUDGED, judged, true);
    const outcomes = fallout(
      pair.effect.changeId,
      declaredEffect(pair.effect.proposition),
      [pair.premise],
      [],
    );
    for (const outcome of outcomes) {
      if (outcome._tag === "conflict") {
        const conflictId = conflictIdOf(subject.projectId, pair);
        const opened = suspectDrafts(tx, at, conflictId, {
          _tag: "Suspect",
          kind: "semantic",
          parties: [pair.premise.holder, pair.effect.changeId],
          subjectId: subject.id,
          subjectKey: subject.key,
          predicate: pair.premise.proposition.predicate,
          origin: "fallout",
          premise: pair.premise,
          effect: pair.effect,
        });
        if (Result.isFailure(opened)) {
          problems.push(`fallout could not open ${conflictId}: ${opened.failure._tag}`);
          continue;
        }
        tx.outbox.subscribe(PROBE_WORKFLOW, ["ConflictSuspected"]);
        drafts.push(...opened.success);
      } else if (outcome._tag === "suspect") {
        const suspected = PremiseSuspected.make({
          subjectId: subject.id,
          changeId: pair.premise.holder,
          premise: pair.premise.proposition,
          cause: { changeId: pair.effect.changeId, effect: pair.effect.proposition },
        });
        drafts.push({
          payload: payloadOf(Schema.encodeSync(PremiseSuspected)(suspected)),
          affected: [changeRef(pair.premise.holder)],
        });
      }
    }
  }
  return { drafts, problems };
}
