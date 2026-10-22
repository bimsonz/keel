import { Schema } from "effect";
import {
  AlternativeDeclared,
  AlternativeLanded,
  alternativeDeclared,
  alternativeLanded,
  alternativesOf,
  ChangeAdopted,
  claimSetOf,
  DerivedEffect,
  EffectsDerived,
  Intent,
  IntentDeclared,
  IntentRevised,
  type LiveChange,
  nearKeysOf,
  nearLookupsOf,
  PreflightIssued,
  reviseIntent,
  type SubjectAnchors,
  type SubjectKey,
} from "../../domain/coordination/index.ts";
import {
  AgentId,
  type Anchor,
  canonicalJson,
  ChangeId,
  type EntityRef,
  type EventEnvelope,
  type ProjectId,
} from "../../domain/kernel/index.ts";
import type { EventDraft, LiveNear, Stored, Transaction } from "../ports/index.ts";
import { CHANGE_ENDS } from "./change.ts";

type Store = Transaction["store"];

/**
 * A project's live changes, as its Project DO indexes them: one row per
 * change from its IntentDeclared until it ends, holding its current intent
 * and the effects last derived for it. A preflight reads only the rows near
 * its intent, found by the key rows below (`liveNear`), which the same fold
 * keeps in the same transaction.
 */
export const LIVE_CHANGE = "live-change";
/** Where on its change's log each row's derivation was made: a later one replaces it, an earlier one arriving late does not. */
export const LIVE_DERIVED_AT = "live-derived-at";
/** Each live change's agent, so the Project DO can tell it about the change's alternatives. */
export const LIVE_AGENT = "live-agent";
/**
 * `<a>/<b>`: a's agent has been shown b as an alternative, by its own
 * preflight or by a notice. Once a preflight has settled a pair it is held
 * under both orders, so a change's pairs are all read under its own id.
 */
export const ALT_SHOWN = "alt-shown";

// The key rows (`nearKeysOf`), each id ending with its change's id.

/** `<subject>/<changeId>`: the change states the subject or one beneath it; `{holds}` is whether it states this one itself. */
export const LIVE_SUBJECT = "live-subject";
/** `<prefix>|<changeId>`: a footprint glob of the change has this literal prefix (`footprintPrefix`), its segments escaped and joined by `/`; the root's is empty. */
export const LIVE_FOOTPRINT = "live-footprint";
/** `<path>|<changeId>`, the path escaped: a proposition of the change is anchored at the path. */
export const LIVE_ANCHOR = "live-anchor";
/** `<claims>|<changeId>`: the change's declared effects make these claims, its claim set (`claimSetOf`) as escaped canonical JSON. */
export const LIVE_CLAIM = "live-claim";
/** Its one row, `built`, says every live change has its key rows: an index from before them builds them first. */
export const LIVE_KEYS = "live-keys";
const BUILT = "built";

/** The notices the Project DO commits for a change's agent, delivered on its subscription scoped to that change. */
export const ALTERNATIVE_NOTICES = ["AlternativeDeclared", "AlternativeLanded"] as const;

/** The index's row: the domain's `LiveChange`, as it is stored and crosses RPC. */
export const LiveChangeRow = Schema.Struct({
  id: ChangeId,
  intent: Intent,
  derived: Schema.Array(DerivedEffect),
});

const decodeRow = Schema.decodeUnknownSync(LiveChangeRow);
const decodeSubjectRow = Schema.decodeUnknownSync(Schema.Struct({ holds: Schema.Boolean }));
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

/** A key part with `%`, `/` and `|` percent-escaped, so that in a key row's id those only ever separate. */
const escaped = (part: string): string => part.replaceAll(/[%/|]/g, (c) => encodeURIComponent(c));
const footprintKey = (prefix: readonly string[]): string => prefix.map(escaped).join("/");
const claimsKey = (claims: readonly string[]): string => escaped(canonicalJson(claims));
/** The change ids of key rows: what follows each id's last separator. */
const changesOf = (rows: readonly { readonly id: string }[], separator: "/" | "|") =>
  rows.map(({ id }) => id.slice(id.lastIndexOf(separator) + 1));

/** A live change's key rows, as kind, id and value: where `nearKeysOf` finds it. */
function keyRowsOf(
  changeId: string,
  live: LiveChange,
): readonly (readonly [string, string, Stored])[] {
  const keys = nearKeysOf(live);
  return [
    ...[...keys.subjects].map(
      ([subject, holds]) => [LIVE_SUBJECT, `${subject}/${changeId}`, { holds }] as const,
    ),
    ...keys.footprints.map(
      (prefix) => [LIVE_FOOTPRINT, `${footprintKey(prefix)}|${changeId}`, true] as const,
    ),
    ...keys.anchors.map((path) => [LIVE_ANCHOR, `${escaped(path)}|${changeId}`, true] as const),
    ...(keys.claims.length === 0
      ? []
      : [[LIVE_CLAIM, `${claimsKey(keys.claims)}|${changeId}`, true] as const]),
  ];
}

const writeKeys = (store: Store, changeId: string, live: LiveChange) => {
  for (const [kind, id, value] of keyRowsOf(changeId, live)) store.put(kind, id, value);
};
const removeKeys = (store: Store, changeId: string, live: LiveChange) => {
  for (const [kind, id] of keyRowsOf(changeId, live)) store.remove(kind, id);
};

/** Puts a change's row, first moving its key rows off what it held (`held`) onto what it holds now. */
function putLive(
  store: Store,
  changeId: ChangeId,
  held: LiveChange | undefined,
  live: LiveChange,
): void {
  if (held !== undefined) removeKeys(store, changeId, held);
  writeKeys(store, changeId, live);
  store.put(LIVE_CHANGE, changeId, encodeRow(live));
}

/**
 * Builds every live change's key rows once, on an index that holds rows from
 * before there were any, and marks it built. The fold and each read near an
 * intent run it first, so a Project DO from before answers right at once.
 */
function ensureKeys(store: Store): void {
  if (store.get(LIVE_KEYS, BUILT) !== undefined) return;
  for (const { id, value } of store.list(LIVE_CHANGE)) writeKeys(store, id, decodeRow(value));
  store.put(LIVE_KEYS, BUILT, true);
}

/** The live changes of these ids, in change id order, as the whole index lists them; an id with no row is left out. */
function liveRows(store: Store, ids: Iterable<string>): readonly LiveChange[] {
  return [...new Set(ids)].toSorted().flatMap((id) => {
    const stored = store.get(LIVE_CHANGE, id);
    return stored === undefined ? [] : [decodeRow(stored)];
  });
}

/** The live changes whose declared effects make the claims `intent`'s make: its alternatives, read by their claim set. */
function claimingAlike(store: Store, intent: Intent): readonly LiveChange[] {
  const claims = claimSetOf(intent);
  return claims.length === 0
    ? []
    : liveRows(store, changesOf(store.list(LIVE_CLAIM, `${claimsKey(claims)}|`), "|"));
}

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
  const alternatives = alternativesOf(self.id, self.intent, claimingAlike(store, self.intent));
  for (const other of listed) store.put(ALT_SHOWN, shownId(self.id, other), true);
  for (const { id } of store.list(ALT_SHOWN, `${self.id}/`)) {
    const other = id.slice(self.id.length + 1);
    if (alternatives.some((alt) => alt === other)) continue;
    store.remove(ALT_SHOWN, id);
    store.remove(ALT_SHOWN, `${other}/${self.id}`);
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

/** Forgets an ended change: its row and key rows, its agent's subscription and every pair it was in. */
function forget(
  tx: Pick<Transaction, "store" | "outbox">,
  changeId: ChangeId,
  live: LiveChange | undefined,
): void {
  const agent = agentOf(tx.store, changeId);
  if (agent !== undefined)
    tx.outbox.unsubscribe(`agent:${agent}`, ALTERNATIVE_NOTICES, changeRef(changeId));
  tx.store.remove(LIVE_AGENT, changeId);
  if (live !== undefined) removeKeys(tx.store, changeId, live);
  tx.store.remove(LIVE_CHANGE, changeId);
  tx.store.remove(LIVE_DERIVED_AT, changeId);
  for (const { id } of tx.store.list(ALT_SHOWN, `${changeId}/`)) {
    tx.store.remove(ALT_SHOWN, id);
    tx.store.remove(ALT_SHOWN, `${id.slice(changeId.length + 1)}/${changeId}`);
  }
}

/** The goal a live change of the project declared or revised to, as its row holds it until the change ends. */
export function liveGoalOf(store: Store, changeId: ChangeId): string | undefined {
  const stored = store.get(LIVE_CHANGE, changeId);
  return stored === undefined ? undefined : decodeRow(stored).intent.goal;
}

/**
 * Folds one event of a change into its project's index, inside the
 * transaction that receives it, and answers the notices it gives. A revision
 * folds through the domain's `reviseIntent`; a derivation replaces the row's
 * effects when it is later on the change's log than the one they came from
 * (two Precheck passes can share a revision); an end removes the row. Each
 * row's key rows move with it. Each issued preflight settles who has been
 * shown which alternative; a landing tells each of the lander's
 * alternatives. An event for a change the index never saw declared is
 * ignored: there is no backfill of earlier changes.
 */
export function hearLiveChange(
  tx: Pick<Transaction, "store" | "outbox">,
  projectId: ProjectId,
  event: EventEnvelope,
): readonly EventDraft[] {
  const { store } = tx;
  if (event.entity.kind !== "change") return [];
  const changeId = Schema.decodeUnknownSync(ChangeId)(event.entity.id);
  ensureKeys(store);
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
      putLive(store, changeId, live, { id: declared.changeId, intent, derived: [] });
      // A proposal no agent holds has nobody to tell of its alternatives.
      if (declared.agentId !== undefined) {
        store.put(LIVE_AGENT, changeId, declared.agentId);
        tx.outbox.subscribe(`agent:${declared.agentId}`, ALTERNATIVE_NOTICES, changeRef(changeId));
      }
      return [];
    }
    case "IntentRevised": {
      if (live === undefined) return [];
      const revised = Schema.decodeUnknownSync(IntentRevised)(event.payload);
      putLive(store, changeId, live, { ...live, intent: reviseIntent(live.intent, revised) });
      return [];
    }
    case "EffectsDerived": {
      if (live === undefined) return [];
      const held = store.get(LIVE_DERIVED_AT, changeId);
      if (typeof held === "number" && held >= event.seq) return [];
      const derived = Schema.decodeUnknownSync(EffectsDerived)(event.payload);
      putLive(store, changeId, live, { ...live, derived: derived.effects });
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
          ? alternativesOf(changeId, live.intent, claimingAlike(store, live.intent)).map((other) =>
              noticeFor(
                other,
                payloadOf(encodeLanded(alternativeLanded(projectId, other, changeId))),
              ),
            )
          : [];
      forget(tx, changeId, live);
      return told;
    }
  }
}

/** Every live change in the index, in change id order. */
export function liveChanges(store: Store): readonly LiveChange[] {
  return store.list(LIVE_CHANGE).map(({ value }) => decodeRow(value));
}

/**
 * The live changes near `intent`, read by key (`nearLookupsOf`) rather than
 * the whole index, `self` left out, in change id order as `liveChanges` lists
 * them: exposure over them finds what it finds over every live change.
 * `compared` counts them, and the subject keys looked up. Builds the key rows
 * first on an index from before them, so run it inside a transaction.
 */
export function liveNear(store: Store, self: ChangeId, intent: Intent): LiveNear {
  ensureKeys(store);
  const lookups = nearLookupsOf(intent);
  const asked = new Set<string>();
  const found: string[] = [];
  const read = (kind: string, prefix: string, separator: "/" | "|") => {
    if (asked.has(`${kind}\u0000${prefix}`)) return;
    asked.add(`${kind}\u0000${prefix}`);
    found.push(...changesOf(store.list(kind, prefix), separator));
  };
  for (const subject of lookups.around) read(LIVE_SUBJECT, `${subject}/`, "/");
  for (const subject of lookups.holding)
    for (const row of store.list(LIVE_SUBJECT, `${subject}/`))
      if (decodeSubjectRow(row.value).holds) found.push(...changesOf([row], "/"));
  for (const prefix of lookups.footprints) {
    if (prefix.length === 0) read(LIVE_FOOTPRINT, "", "|");
    else {
      for (let depth = 0; depth <= prefix.length; depth++)
        read(LIVE_FOOTPRINT, `${footprintKey(prefix.slice(0, depth))}|`, "|");
      read(LIVE_FOOTPRINT, `${footprintKey(prefix)}/`, "|");
    }
  }
  for (const path of lookups.anchors) read(LIVE_ANCHOR, `${escaped(path)}|`, "|");
  if (lookups.claims.length > 0) read(LIVE_CLAIM, `${claimsKey(lookups.claims)}|`, "|");
  const changes = liveRows(
    store,
    found.filter((id) => id !== self),
  );
  return {
    changes,
    compared: { changes: changes.length, subjects: lookups.around.length + lookups.holding.length },
  };
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
