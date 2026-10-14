import { Result, Schema } from "effect";
import {
  claimKey,
  declaredEffect,
  type DerivedEffect,
  fallout,
  isAncestorOrSelf,
  type JudgedEffect,
  PremiseSuspected,
  type Proposition,
  sameProposition,
  type SubjectKey,
} from "../../domain/coordination/index.ts";
import {
  type Anchor,
  canonicalJson,
  type ChangeId,
  ConflictId,
  type EntityRef,
  type Instant,
  type ProjectId,
  type SubjectId,
} from "../../domain/kernel/index.ts";
import { suspectEvidence } from "../../domain/verification/index.ts";
import type { EventDraft, Transaction } from "../ports/index.ts";
import { hashedIdBody } from "./hashed-id.ts";
import { suspectDrafts } from "./probe-ledger.ts";

/** One change's premise and another change's effect, declared or derived: what fallout judges. */
export interface FalloutPair {
  readonly premise: { readonly holder: ChangeId; readonly proposition: Proposition };
  readonly effect: { readonly changeId: ChangeId; readonly proposition: Proposition };
  /** The effect as it is judged: its agent's own claim, or what Keel derived, with its method and evidence class. */
  readonly judged: JudgedEffect;
}

/**
 * What a subject holds of one change: its premises and declared effects at or
 * under the key, and the effects last derived for it there.
 */
export interface HeldBy {
  readonly changeId: ChangeId;
  readonly premises: readonly Proposition[];
  readonly declaredEffects: readonly Proposition[];
  readonly derived: readonly DerivedEffect[];
  /** The anchors on this subject the change's last derivation found its diff touching. */
  readonly touched?: readonly Anchor[];
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
 * The effects a subject judges for a change, one for each claim: a declared
 * effect as its agent's own testimony, and a derived effect the agent had not
 * declared as Keel derived it, a ruling ahead of an opinion. A claim both
 * declared and derived is one effect, the same one whichever arrived first.
 */
export function judgedEffects(
  held: Pick<HeldBy, "declaredEffects" | "derived">,
): readonly JudgedEffect[] {
  const ranked: readonly JudgedEffect[] = [
    ...held.declaredEffects.map(declaredEffect),
    ...held.derived.filter((effect) => effect.evidenceClass !== "opinion"),
    ...held.derived.filter((effect) => effect.evidenceClass === "opinion"),
  ];
  const claims = new Set<string>();
  return ranked.filter((effect) => {
    const claim = claimKey(effect.proposition);
    if (claims.has(claim)) return false;
    claims.add(claim);
    return true;
  });
}

/**
 * The pairs a change's declare, revision or derivation brings to the subject
 * at `key`: its new effects against every other change's premises, and its
 * new premises against every other change's effects, those judged here. An
 * effect is declared or derived alike. Whichever side arrives second brings
 * the pair, so a race judges it once.
 */
export function falloutPairs(
  key: SubjectKey,
  change: { readonly changeId: ChangeId; readonly before: HeldBy; readonly after: HeldBy },
  others: readonly HeldBy[],
): readonly FalloutPair[] {
  const had = new Set(judgedEffects(change.before).map((effect) => claimKey(effect.proposition)));
  const effects = judgedEffects(change.after).filter(
    (effect) => !had.has(claimKey(effect.proposition)),
  );
  const premises = fresh(change.after.premises, change.before.premises);
  const pairs: FalloutPair[] = [];
  for (const other of others) {
    if (other.changeId === change.changeId) continue;
    for (const judged of effects)
      for (const premise of other.premises)
        pairs.push({
          premise: { holder: other.changeId, proposition: premise },
          effect: { changeId: change.changeId, proposition: judged.proposition },
          judged,
        });
    for (const premise of premises)
      for (const judged of judgedEffects(other))
        pairs.push({
          premise: { holder: change.changeId, proposition: premise },
          effect: { changeId: other.changeId, proposition: judged.proposition },
          judged,
        });
  }
  return pairs.filter((pair) =>
    judgedHere(key, pair.premise.proposition.subject, pair.effect.proposition.subject),
  );
}

/**
 * A pair's identity: who relies on which claim, how firmly, and whose effect
 * claims what. The same whichever side arrived first, and whether the effect
 * was declared, derived or both: anchors and gloss say where, not what. The
 * premise's strength is part of it, since it decides between a conflict and a
 * suspicion.
 */
const pairKey = (pair: Pick<FalloutPair, "premise" | "effect">): string =>
  canonicalJson({
    holder: pair.premise.holder,
    premise: claimKey(pair.premise.proposition),
    strength: pair.premise.proposition.strength ?? "must",
    changeId: pair.effect.changeId,
    effect: claimKey(pair.effect.proposition),
  });

/** The conflict a pair opens: derived from the project and the pair, so a race opens one. */
export const conflictIdOf = (
  projectId: ProjectId,
  pair: Pick<FalloutPair, "premise" | "effect">,
): ConflictId => ConflictId.make(`cfl_${hashedIdBody(`${projectId}\n${pairKey(pair)}`)}`);

const changeRef = (changeId: ChangeId): EntityRef => ({ kind: "change", id: changeId });
const payloadOf = (encoded: unknown): EventDraft["payload"] => JSON.parse(JSON.stringify(encoded));

/**
 * Judges each pair not judged before, inside the reaction's transaction, with
 * the domain's `fallout` on the effect as it is judged (a declared effect is
 * the agent's own claim, a derived one carries its method):
 * - a conflict opens one on `conflict:<cid>` (ConflictSuspected, its row, its
 *   parties subscribed) and subscribes the Probe Workflow to start on it; its
 *   origin is `opinion` when the effect is a model's opinion, else `fallout`;
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
    const outcomes = fallout(pair.effect.changeId, pair.judged, [pair.premise], []);
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
          origin: pair.judged.evidenceClass === "opinion" ? "opinion" : "fallout",
          premise: pair.premise,
          effect: { ...pair.effect, evidence: suspectEvidence(pair.judged) },
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

/**
 * One change's premise anchored to code another change's diff touched, where
 * no effect of that change was judged against the premise: a suspicion with
 * no effect behind it.
 */
export interface AnchorPair {
  readonly premise: { readonly holder: ChangeId; readonly proposition: Proposition };
  readonly changeId: ChangeId;
  readonly anchor: Anchor;
}

/** Two anchors on the same code: one path and one symbol (or none), whatever commit each was pinned at. */
const sameCode = (a: Anchor, b: Anchor): boolean =>
  a.path === b.path && (a.symbol ?? null) === (b.symbol ?? null);

/**
 * The anchor pairs a change's derivation or revision brings to the subject at
 * `key`: the anchors its diff newly touched against every other change's
 * premises on `key` anchored there, and its new premises against the anchors
 * every other change's diff touched. A pair whose touching change has an
 * effect on the premise's subject and predicate is fallout's to judge, and is
 * left out. Whichever side arrives second brings the pair.
 */
export function anchorPairs(
  key: SubjectKey,
  change: { readonly changeId: ChangeId; readonly before: HeldBy; readonly after: HeldBy },
  others: readonly HeldBy[],
): readonly AnchorPair[] {
  const touchedNow = (change.after.touched ?? []).filter(
    (anchor) => !(change.before.touched ?? []).some((was) => sameCode(was, anchor)),
  );
  const premises = fresh(change.after.premises, change.before.premises);
  const restsOn = (premise: Proposition, anchor: Anchor): boolean =>
    premise.subject === key && (premise.anchors ?? []).some((at) => sameCode(at, anchor));
  const judgedBy = (held: HeldBy, premise: Proposition): boolean =>
    judgedEffects(held).some(
      (effect) =>
        effect.proposition.subject === premise.subject &&
        effect.proposition.predicate === premise.predicate,
    );
  const pairs: AnchorPair[] = [];
  for (const other of others) {
    if (other.changeId === change.changeId) continue;
    for (const anchor of touchedNow)
      for (const premise of other.premises)
        if (restsOn(premise, anchor) && !judgedBy(change.after, premise))
          pairs.push({
            premise: { holder: other.changeId, proposition: premise },
            changeId: change.changeId,
            anchor,
          });
    for (const premise of premises)
      for (const anchor of other.touched ?? [])
        if (restsOn(premise, anchor) && !judgedBy(other, premise))
          pairs.push({
            premise: { holder: change.changeId, proposition: premise },
            changeId: other.changeId,
            anchor,
          });
  }
  return pairs;
}

/**
 * Tells each premise's holder that a change edits code the premise rests on:
 * PremiseSuspected with the anchor as its cause, once per pair (its row by the
 * pair's identity). It opens no conflict and holds nothing: the holder checks
 * its premise against the change, and revises or relies again if it no longer
 * holds.
 */
export function judgeAnchors(
  tx: Pick<Transaction, "store">,
  subject: { readonly id: SubjectId },
  pairs: readonly AnchorPair[],
): readonly EventDraft[] {
  const drafts: EventDraft[] = [];
  for (const pair of pairs) {
    const judged = hashedIdBody(
      canonicalJson({
        holder: pair.premise.holder,
        premise: claimKey(pair.premise.proposition),
        changeId: pair.changeId,
        anchor: { path: pair.anchor.path, symbol: pair.anchor.symbol ?? null },
      }),
    );
    if (tx.store.get(FALLOUT_JUDGED, judged) !== undefined) continue;
    tx.store.put(FALLOUT_JUDGED, judged, true);
    const suspected = PremiseSuspected.make({
      subjectId: subject.id,
      changeId: pair.premise.holder,
      premise: pair.premise.proposition,
      cause: { changeId: pair.changeId, anchor: pair.anchor },
    });
    drafts.push({
      payload: payloadOf(Schema.encodeSync(PremiseSuspected)(suspected)),
      affected: [changeRef(pair.premise.holder)],
    });
  }
  return drafts;
}
