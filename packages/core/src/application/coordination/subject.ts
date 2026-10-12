import { Schema } from "effect";
import {
  ChangeAdopted,
  type Intent,
  IntentDeclared,
  IntentRevised,
  isAncestorOrSelf,
  PremiseRelied,
  Proposition,
  reviseIntent,
  sameProposition,
  type SubjectKey,
  SubjectMinted,
} from "../../domain/coordination/index.ts";
import {
  AgentId,
  ChangeId,
  type EntityRef,
  type EventEnvelope,
  type ProjectId,
  SubjectId,
} from "../../domain/kernel/index.ts";
import type { EntityStore, EventDraft, Stored, Transaction } from "../ports/index.ts";
import { CHANGE_ENDS } from "./change.ts";
import { hashedIdBody } from "./hashed-id.ts";
import { falloutPairs, judgeFallout } from "./subject-fallout.ts";

export { hashedIdBody } from "./hashed-id.ts";

type Store = (typeof EntityStore)["Service"];

/**
 * A subject's id, derived from its project and key: `sub_` and the first 130
 * bits of sha256(`<project>\n<key>`) in Crockford base32. Any object names a
 * subject without asking a registry, and the same key in two projects is two
 * subjects.
 */
export function subjectIdOf(projectId: ProjectId, key: SubjectKey): SubjectId {
  return SubjectId.make(`sub_${hashedIdBody(`${projectId}\n${key}`)}`);
}

/**
 * What a Subject DO keeps of each change that names its key or a key beneath
 * it: those premises and declared effects, by change id. Fallout reads it.
 */
export const SUBJECT_HELD = "subject-held";
/** The subject's own record, written with its SubjectMinted: a subject is minted once. */
export const SUBJECT_MINTED = "subject-minted";
/** Each held change's agent, who hears the change's PremiseSuspected: by change id. */
export const HOLDER_AGENT = "holder-agent";

/** What a change's agent hears from a subject, on its subscription scoped to that change. */
export const HOLDER_HEARS = ["PremiseSuspected"] as const;

const Held = Schema.Struct({
  premises: Schema.Array(Proposition),
  declaredEffects: Schema.Array(Proposition),
});
type Held = typeof Held.Type;

const decodeHeld = Schema.decodeUnknownSync(Held);
const asStored = (encoded: unknown): Stored => JSON.parse(JSON.stringify(encoded));
const payloadOf = (encoded: unknown): EventDraft["payload"] => JSON.parse(JSON.stringify(encoded));

const NOTHING: Held = { premises: [], declaredEffects: [] };

/**
 * What the subject commits on hearing a change: on its own entity, in its
 * project (a conflict it opens goes on the conflict's), and the problems
 * fallout met, for the object to log.
 */
export type SubjectReaction = (
  | {
      readonly entity: EntityRef;
      readonly drafts: readonly EventDraft[];
      readonly project: ProjectId;
    }
  | { readonly drafts: readonly [] }
) & { readonly problems?: readonly string[] };

/** The propositions at or under `key`: what this subject holds of an intent. */
const under = (key: SubjectKey, intent: Pick<Intent, "premises" | "declaredEffects">): Held => ({
  premises: intent.premises.filter((premise) => isAncestorOrSelf(key, premise.subject)),
  declaredEffects: (intent.declaredEffects ?? []).filter((effect) =>
    isAncestorOrSelf(key, effect.subject),
  ),
});

/** The held propositions as an intent, so a revision folds through the domain's `reviseIntent`. */
const asIntent = (held: Held): Intent => ({
  revision: 0,
  goal: "",
  footprint: [],
  premises: held.premises,
  declaredEffects: held.declaredEffects,
});

/**
 * A Subject DO (`subj:<project>:<key>`) hears one event of a change that
 * relies on or affects its key or a key beneath it, inside the transaction
 * that receives it. A declare or revision folds into what the subject holds of
 * that change (a change it never heard of holds nothing yet, so a revision
 * naming the key for the first time starts it); an end drops the change.
 *
 * The first time the subject holds anything it commits SubjectMinted, its
 * anchors and gloss from a proposition at exactly its key if there is one,
 * else none and the key. Each premise new at exactly its key commits
 * PremiseRelied; an ancestor keeps a descendant's premise without relying it.
 */
export function hearSubject(
  tx: Pick<Transaction, "store" | "outbox">,
  projectId: ProjectId,
  key: SubjectKey,
  event: EventEnvelope,
): SubjectReaction {
  const { store } = tx;
  if (event.entity.kind !== "change") return { drafts: [] };
  const changeId = Schema.decodeUnknownSync(ChangeId)(event.entity.id);
  if (event.type === "ChangeAdopted") {
    adopted(tx, changeId, Schema.decodeUnknownSync(ChangeAdopted)(event.payload).agentId);
    return { drafts: [] };
  }
  const stored = store.get(SUBJECT_HELD, changeId);
  const before = stored === undefined ? NOTHING : decodeHeld(stored);
  let after: Held;
  let relier: ChangeId;
  switch (event.type) {
    case "IntentDeclared": {
      const declared = Schema.decodeUnknownSync(IntentDeclared)(event.payload);
      after = under(key, declared);
      relier = declared.changeId;
      heldBy(tx, changeId, declared.agentId);
      break;
    }
    case "IntentRevised": {
      const revised = Schema.decodeUnknownSync(IntentRevised)(event.payload);
      after = under(key, reviseIntent(asIntent(before), revised));
      relier = revised.changeId;
      const actor = event.actor?.startsWith("agent:")
        ? event.actor.slice("agent:".length)
        : undefined;
      if (store.get(HOLDER_AGENT, changeId) === undefined && actor !== undefined)
        heldBy(tx, changeId, Schema.decodeUnknownSync(AgentId)(actor));
      break;
    }
    default:
      if ((CHANGE_ENDS as readonly string[]).includes(event.type)) {
        store.remove(SUBJECT_HELD, changeId);
        const agent = holderAgent(store, changeId);
        if (agent !== undefined)
          tx.outbox.unsubscribe(`agent:${agent}`, HOLDER_HEARS, changeRef(changeId));
        store.remove(HOLDER_AGENT, changeId);
      }
      return { drafts: [] };
  }
  if (after.premises.length === 0 && after.declaredEffects.length === 0)
    store.remove(SUBJECT_HELD, changeId);
  else store.put(SUBJECT_HELD, changeId, asStored(Schema.encodeSync(Held)(after)));

  const subjectId = subjectIdOf(projectId, key);
  const drafts: EventDraft[] = [];
  const touched = [...after.premises, ...after.declaredEffects];
  if (touched.length > 0 && store.get(SUBJECT_MINTED, subjectId) === undefined) {
    const own = touched.find((proposition) => proposition.subject === key);
    const minted = SubjectMinted.make({
      subjectId,
      key,
      anchors: own?.anchors ?? [],
      gloss: own?.gloss ?? key,
      mintedBy: "agent",
    });
    store.put(SUBJECT_MINTED, subjectId, asStored(Schema.encodeSync(SubjectMinted)(minted)));
    drafts.push({ payload: payloadOf(Schema.encodeSync(SubjectMinted)(minted)) });
  }
  for (const premise of after.premises) {
    if (premise.subject !== key) continue;
    if (before.premises.some((held) => sameProposition(held, premise))) continue;
    const relied = PremiseRelied.make({ subjectId, changeId: relier, premise });
    drafts.push({ payload: payloadOf(Schema.encodeSync(PremiseRelied)(relied)) });
  }
  const others = store
    .list(SUBJECT_HELD)
    .filter((row) => row.id !== changeId)
    .map((row) => ({
      changeId: Schema.decodeUnknownSync(ChangeId)(row.id),
      ...decodeHeld(row.value),
    }));
  const judged = judgeFallout(
    tx,
    event.at,
    { projectId, key, id: subjectId },
    falloutPairs(
      key,
      { changeId, before: { changeId, ...before }, after: { changeId, ...after } },
      others,
    ),
  );
  drafts.push(...judged.drafts);
  const problems = judged.problems.length === 0 ? {} : { problems: judged.problems };
  return drafts.length === 0
    ? { drafts: [], ...problems }
    : { entity: { kind: "subject", id: subjectId }, drafts, project: projectId, ...problems };
}

const changeRef = (changeId: ChangeId): EntityRef => ({ kind: "change", id: changeId });

const holderAgent = (store: Store, changeId: ChangeId): AgentId | undefined => {
  const stored = store.get(HOLDER_AGENT, changeId);
  return stored === undefined ? undefined : Schema.decodeUnknownSync(AgentId)(stored);
};

/** Keeps the change's agent and subscribes it to what the subject tells about the change. */
function heldBy(tx: Pick<Transaction, "store" | "outbox">, changeId: ChangeId, agentId: AgentId) {
  tx.store.put(HOLDER_AGENT, changeId, agentId);
  tx.outbox.subscribe(`agent:${agentId}`, HOLDER_HEARS, changeRef(changeId));
}

/** An adopt moves the change's subscription from the agent that let it lapse to the adopter. */
function adopted(tx: Pick<Transaction, "store" | "outbox">, changeId: ChangeId, agentId: AgentId) {
  const previous = holderAgent(tx.store, changeId);
  if (previous === undefined || previous === agentId) return;
  tx.outbox.unsubscribe(`agent:${previous}`, HOLDER_HEARS, changeRef(changeId));
  heldBy(tx, changeId, agentId);
}
