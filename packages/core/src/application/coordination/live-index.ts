import { Schema } from "effect";
import {
  AlternativeDeclared,
  AlternativeLanded,
  alternativeDeclared,
  alternativeLanded,
  alternativesOf,
  ChangeAdopted,
  DerivedEffect,
  EffectsDerived,
  Intent,
  IntentDeclared,
  IntentRevised,
  type LiveChange,
  PreflightIssued,
  reviseIntent,
  type SubjectAnchors,
  type SubjectKey,
} from "../../domain/coordination/index.ts";
import {
  AgentId,
  type Anchor,
  ChangeId,
  type EntityRef,
  type EventEnvelope,
  type ProjectId,
} from "../../domain/kernel/index.ts";
import type { EventDraft, Stored, Transaction } from "../ports/index.ts";
import { CHANGE_ENDS } from "./change.ts";

type Store = Transaction["store"];

/**
 * A project's live changes, as its Project DO indexes them: one row per
 * change from its IntentDeclared until it ends, holding its current intent
 * and the effects last derived for it. Preflight reads the whole index once.
 */
export const LIVE_CHANGE = "live-change";
/** Where on its change's log each row's derivation was made: a later one replaces it, an earlier one arriving late does not. */
export const LIVE_DERIVED_AT = "live-derived-at";
/** Each live change's agent, so the Project DO can tell it about the change's alternatives. */
export const LIVE_AGENT = "live-agent";
/** `<a>/<b>`: a's agent has been shown b as an alternative, by its own preflight or by a notice. */
export const ALT_SHOWN = "alt-shown";

/** The notices the Project DO commits for a change's agent, delivered on its subscription scoped to that change. */
export const ALTERNATIVE_NOTICES = ["AlternativeDeclared", "AlternativeLanded"] as const;

/** The index's row: the domain's `LiveChange`, as it is stored and crosses RPC. */
export const LiveChangeRow = Schema.Struct({
  id: ChangeId,
  intent: Intent,
  derived: Schema.Array(DerivedEffect),
});

const decodeRow = Schema.decodeUnknownSync(LiveChangeRow);
const encodeRow = (row: LiveChange): Stored =>
  JSON.parse(JSON.stringify(Schema.encodeSync(LiveChangeRow)(row)));
const payloadOf = (encoded: unknown): EventDraft["payload"] => JSON.parse(JSON.stringify(encoded));
const encodeDeclared = Schema.encodeSync(AlternativeDeclared);
const encodeLanded = Schema.encodeSync(AlternativeLanded);

const changeRef = (changeId: ChangeId): EntityRef => ({ kind: "change", id: changeId });
const shownId = (a: ChangeId, b: ChangeId): string => `${a}/${b}`;
const agentOf = (store: Store, changeId: ChangeId): AgentId | undefined => {
  const stored = store.get(LIVE_AGENT, changeId);
  return stored === undefined ? undefined : Schema.decodeUnknownSync(AgentId)(stored);
};

/** A notice for `target`'s agent, on the project, about `target`. */
const noticeFor = (target: ChangeId, payload: EventDraft["payload"]): EventDraft => ({
  payload,
  affected: [changeRef(target)],
});

/**
 * Who has been shown whom, after `changeId`'s preflight listed `listed`: each
 * pair of alternatives learns of each other once, by the preflight or by a
 * notice. A declarer whose preflight read the index before an alternative
 * reached it is told by a notice too. Pairs that are no longer alternatives
 * are forgotten, so converging again tells both again. Keel never ranks them.
 */
function aware(
  store: Store,
  projectId: ProjectId,
  self: LiveChange,
  listed: readonly ChangeId[],
): readonly EventDraft[] {
  const live = liveChanges(store);
  const alternatives = alternativesOf(self.id, self.intent, live);
  for (const other of listed) store.put(ALT_SHOWN, shownId(self.id, other), true);
  for (const { id } of store.list(ALT_SHOWN)) {
    const [a, b] = id.split("/");
    const other = a === self.id ? b : b === self.id ? a : undefined;
    if (other !== undefined && !alternatives.some((alt) => alt === other))
      store.remove(ALT_SHOWN, id);
  }
  const drafts: EventDraft[] = [];
  const tell = (target: ChangeId, about: ChangeId) => {
    if (store.get(ALT_SHOWN, shownId(target, about)) !== undefined) return;
    store.put(ALT_SHOWN, shownId(target, about), true);
    drafts.push(
      noticeFor(target, payloadOf(encodeDeclared(alternativeDeclared(projectId, target, about)))),
    );
  };
  for (const other of alternatives) {
    tell(other, self.id);
    tell(self.id, other);
  }
  return drafts;
}

/** Forgets an ended change: its row, its agent's subscription and every pair it was in. */
function forget(tx: Pick<Transaction, "store" | "outbox">, changeId: ChangeId): void {
  const agent = agentOf(tx.store, changeId);
  if (agent !== undefined)
    tx.outbox.unsubscribe(`agent:${agent}`, ALTERNATIVE_NOTICES, changeRef(changeId));
  tx.store.remove(LIVE_AGENT, changeId);
  tx.store.remove(LIVE_CHANGE, changeId);
  tx.store.remove(LIVE_DERIVED_AT, changeId);
  for (const { id } of tx.store.list(ALT_SHOWN))
    if (id.split("/").includes(changeId)) tx.store.remove(ALT_SHOWN, id);
}

/**
 * Folds one event of a change into its project's index, inside the
 * transaction that receives it, and answers the notices it gives. A revision
 * folds through the domain's `reviseIntent`; a derivation replaces the row's
 * effects when it is later on the change's log than the one they came from
 * (two Precheck passes can share a revision); an end removes the row. Each
 * issued preflight settles who has been shown which alternative; a landing
 * tells each of the lander's alternatives. An event for a change the index
 * never saw declared is ignored: there is no backfill of earlier changes.
 */
export function hearLiveChange(
  tx: Pick<Transaction, "store" | "outbox">,
  projectId: ProjectId,
  event: EventEnvelope,
): readonly EventDraft[] {
  const { store } = tx;
  if (event.entity.kind !== "change") return [];
  const changeId = Schema.decodeUnknownSync(ChangeId)(event.entity.id);
  const stored = store.get(LIVE_CHANGE, changeId);
  const live = stored === undefined ? undefined : decodeRow(stored);
  switch (event.type) {
    case "IntentDeclared": {
      const declared = Schema.decodeUnknownSync(IntentDeclared)(event.payload);
      const intent: Intent = {
        revision: declared.revision,
        goal: declared.goal,
        footprint: declared.footprint,
        premises: declared.premises,
        ...(declared.declaredEffects === undefined
          ? {}
          : { declaredEffects: declared.declaredEffects }),
      };
      store.put(LIVE_CHANGE, changeId, encodeRow({ id: declared.changeId, intent, derived: [] }));
      store.put(LIVE_AGENT, changeId, declared.agentId);
      tx.outbox.subscribe(`agent:${declared.agentId}`, ALTERNATIVE_NOTICES, changeRef(changeId));
      return [];
    }
    case "IntentRevised": {
      if (live === undefined) return [];
      const revised = Schema.decodeUnknownSync(IntentRevised)(event.payload);
      store.put(
        LIVE_CHANGE,
        changeId,
        encodeRow({ ...live, intent: reviseIntent(live.intent, revised) }),
      );
      return [];
    }
    case "EffectsDerived": {
      if (live === undefined) return [];
      const held = store.get(LIVE_DERIVED_AT, changeId);
      if (typeof held === "number" && held >= event.seq) return [];
      const derived = Schema.decodeUnknownSync(EffectsDerived)(event.payload);
      store.put(LIVE_CHANGE, changeId, encodeRow({ ...live, derived: derived.effects }));
      store.put(LIVE_DERIVED_AT, changeId, event.seq);
      return [];
    }
    case "PreflightIssued": {
      if (live === undefined) return [];
      const issued = Schema.decodeUnknownSync(PreflightIssued)(event.payload);
      return aware(store, projectId, live, issued.alternatives ?? []);
    }
    case "ChangeAdopted": {
      const previous = agentOf(store, changeId);
      if (live === undefined || previous === undefined) return [];
      const adopted = Schema.decodeUnknownSync(ChangeAdopted)(event.payload);
      if (adopted.agentId === previous) return [];
      tx.outbox.unsubscribe(`agent:${previous}`, ALTERNATIVE_NOTICES, changeRef(changeId));
      tx.outbox.subscribe(`agent:${adopted.agentId}`, ALTERNATIVE_NOTICES, changeRef(changeId));
      store.put(LIVE_AGENT, changeId, adopted.agentId);
      return [];
    }
    default: {
      if (!(CHANGE_ENDS as readonly string[]).includes(event.type)) return [];
      const told =
        event.type === "ChangeLanded" && live !== undefined
          ? alternativesOf(changeId, live.intent, liveChanges(store)).map((other) =>
              noticeFor(
                other,
                payloadOf(encodeLanded(alternativeLanded(projectId, other, changeId))),
              ),
            )
          : [];
      forget(tx, changeId);
      return told;
    }
  }
}

/** Every live change in the index, in no particular order. */
export function liveChanges(store: Store): readonly LiveChange[] {
  return store.list(LIVE_CHANGE).map(({ value }) => decodeRow(value));
}

const anchorKey = (anchor: Anchor): string =>
  `${anchor.path}\n${anchor.symbol ?? ""}\n${anchor.commit}`;

/**
 * Where the project's live subjects are anchored in code: for each subject a
 * live change's premise, declared effect or derived effect names with
 * anchors, those anchors, each once, in one order whatever order the index
 * was built in. A subject nothing anchors is left out: derivation attributes
 * a subject from its anchors only.
 */
export function liveAnchors(store: Store): readonly SubjectAnchors[] {
  const bySubject = new Map<SubjectKey, Map<string, Anchor>>();
  const add = (subject: SubjectKey, anchors: readonly Anchor[]) => {
    if (anchors.length === 0) return;
    const held = bySubject.get(subject) ?? new Map<string, Anchor>();
    for (const anchor of anchors) held.set(anchorKey(anchor), anchor);
    bySubject.set(subject, held);
  };
  for (const live of liveChanges(store)) {
    for (const named of [...live.intent.premises, ...(live.intent.declaredEffects ?? [])])
      add(named.subject, named.anchors ?? []);
    for (const effect of live.derived) add(effect.proposition.subject, effect.anchors);
  }
  return [...bySubject.keys()].toSorted().map((subject) => {
    const held = bySubject.get(subject) ?? new Map<string, Anchor>();
    return { subject, anchors: [...held.keys()].toSorted().flatMap((key) => held.get(key) ?? []) };
  });
}
