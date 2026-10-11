import { Schema } from "effect";
import {
  DerivedEffect,
  EffectsDerived,
  Intent,
  IntentDeclared,
  IntentRevised,
  type LiveChange,
  reviseIntent,
} from "../../domain/coordination/index.ts";
import { ChangeId, type EventEnvelope } from "../../domain/kernel/index.ts";
import type { EntityStore, Stored } from "../ports/index.ts";
import { CHANGE_ENDS } from "./change.ts";

type Store = (typeof EntityStore)["Service"];

/**
 * A project's live changes, as its Project DO indexes them: one row per
 * change from its IntentDeclared until it ends, holding its current intent
 * and the effects last derived for it. Preflight reads the whole index once.
 */
export const LIVE_CHANGE = "live-change";

/** The index's row: the domain's `LiveChange`, as it is stored and crosses RPC. */
export const LiveChangeRow = Schema.Struct({
  id: ChangeId,
  intent: Intent,
  derived: Schema.Array(DerivedEffect),
});

const decodeRow = Schema.decodeUnknownSync(LiveChangeRow);
const encodeRow = (row: LiveChange): Stored =>
  JSON.parse(JSON.stringify(Schema.encodeSync(LiveChangeRow)(row)));

/**
 * Folds one event of a change into its project's index, inside the
 * transaction that receives it. A revision folds through the domain's
 * `reviseIntent`; an end removes the row. An event for a change the index
 * never saw declared is ignored: there is no backfill of earlier changes.
 */
export function hearLiveChange(store: Store, event: EventEnvelope): void {
  if (event.entity.kind !== "change") return;
  const changeId = event.entity.id;
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
      return;
    }
    case "IntentRevised": {
      if (live === undefined) return;
      const revised = Schema.decodeUnknownSync(IntentRevised)(event.payload);
      store.put(
        LIVE_CHANGE,
        changeId,
        encodeRow({ ...live, intent: reviseIntent(live.intent, revised) }),
      );
      return;
    }
    case "EffectsDerived": {
      if (live === undefined) return;
      const derived = Schema.decodeUnknownSync(EffectsDerived)(event.payload);
      store.put(LIVE_CHANGE, changeId, encodeRow({ ...live, derived: derived.effects }));
      return;
    }
    default:
      if ((CHANGE_ENDS as readonly string[]).includes(event.type))
        store.remove(LIVE_CHANGE, changeId);
  }
}

/** Every live change in the index, in no particular order. */
export function liveChanges(store: Store): readonly LiveChange[] {
  return store.list(LIVE_CHANGE).map(({ value }) => decodeRow(value));
}
