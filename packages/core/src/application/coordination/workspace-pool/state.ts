import { Schema } from "effect";
import { CommitSha, WorkspaceId } from "../../../domain/kernel/index.ts";
import type { Transaction } from "../../ports/index.ts";

/**
 * The WorkspacePool's own state, in its Durable Object's EntityStore. A
 * workspace is `forking` from the moment its fork is started until the fork
 * resolves; only then is it `ready`, and only a ready one is ever granted.
 * A ready one that trunk has moved past is `refreshing` while trunk is
 * relayed into it, and ready again once its main is known.
 */
export const RepoName = Schema.Struct({ namespace: Schema.String, name: Schema.String });
export type RepoName = typeof RepoName.Type;

export const PoolSettings = Schema.Struct({
  source: Schema.NullOr(RepoName),
  target: Schema.Int,
  /** Set when the project is destroyed, and never unset: the pool then forks and grants nothing. */
  destroyed: Schema.optionalKey(Schema.Boolean),
});
export type PoolSettings = typeof PoolSettings.Type;

export const SlotState = Schema.Literals([
  "forking",
  "ready",
  "refreshing",
  "granted",
  "collecting",
  "collected",
]);
export type SlotState = typeof SlotState.Type;

export const Slot = Schema.Struct({
  id: WorkspaceId,
  repo: RepoName,
  state: SlotState,
  /** When the slot entered its state, in epoch milliseconds. */
  since: Schema.Number,
  holder: Schema.optionalKey(Schema.String),
  /** Stored for the holder only; never logged and never in an event (its host carries the account id). */
  remote: Schema.optionalKey(Schema.String),
  baseSha: Schema.optionalKey(CommitSha),
  /** While refreshing: the trunk commit the relay is taking main to. `baseSha` is still where main was. */
  advancingTo: Schema.optionalKey(CommitSha),
  /** The trunk commits Keel relayed onto main, the newest last and only the last few: a push observed at one of them was Keel's write, not the holder's. */
  relayed: Schema.optionalKey(Schema.Array(CommitSha)),
  /** Failed deletions of the repo so far, while collecting. */
  attempts: Schema.optionalKey(Schema.Int),
});
export type Slot = typeof Slot.Type;

const SETTINGS = "pool-settings";
const SLOT = "workspace";
const HOLDER = "workspace-holder";

const decodeSettings = Schema.decodeUnknownSync(PoolSettings);
const decodeSlot = Schema.decodeUnknownSync(Slot);
const encodeSlot = Schema.encodeSync(Slot);
const decodeHolder = Schema.decodeUnknownSync(Schema.Struct({ workspaceId: WorkspaceId }));

type Store = Transaction["store"];

export const settingsOf = (store: Store): PoolSettings => {
  const stored = store.get(SETTINGS, "pool");
  return stored === undefined ? { source: null, target: 0 } : decodeSettings(stored);
};

export const putSettings = (store: Store, settings: PoolSettings): void =>
  store.put(SETTINGS, "pool", {
    source: settings.source,
    target: settings.target,
    ...(settings.destroyed === true ? { destroyed: true } : {}),
  });

/** Whether the project was destroyed: its pool forks and grants nothing, whatever it is configured to. */
export const isDestroyed = (store: Store): boolean => settingsOf(store).destroyed === true;

export const slotOf = (store: Store, id: string): Slot | undefined => {
  const stored = store.get(SLOT, id);
  return stored === undefined ? undefined : decodeSlot(stored);
};

export const slots = (store: Store): readonly Slot[] =>
  store.list(SLOT).map((row) => decodeSlot(row.value));

export const putSlot = (store: Store, slot: Slot): void =>
  store.put(SLOT, slot.id, encodeSlot(slot));

export const heldBy = (store: Store, holder: string): WorkspaceId | undefined => {
  const stored = store.get(HOLDER, holder);
  return stored === undefined ? undefined : decodeHolder(stored).workspaceId;
};

export const holdFor = (store: Store, holder: string, workspaceId: WorkspaceId): void =>
  store.put(HOLDER, holder, { workspaceId });

export const unhold = (store: Store, holder: string): void => store.remove(HOLDER, holder);

/**
 * Whether the pool may hand the slot out or write to its repo: only a ready
 * one. A slot being forked or refreshed is mid-write, and a granted one is
 * its holder's.
 */
export const isReady = (slot: Slot | undefined): slot is Slot => slot?.state === "ready";

/** The ready slots, the one that has waited longest first. */
const readyInOrder = (store: Store): readonly Slot[] =>
  slots(store)
    .filter(isReady)
    .toSorted((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1));

/** The ready slot that has waited longest, so the pool hands out in fork order. */
export const oldestReady = (store: Store): Slot | undefined => readyInOrder(store)[0];

/** The ready slots whose main is not at `head`, the one that has waited longest first. */
export const readyBehind = (store: Store, head: CommitSha): readonly Slot[] =>
  readyInOrder(store).filter((s) => s.baseSha !== head);

export const countIn = (store: Store, state: SlotState): number =>
  slots(store).filter((s) => s.state === state).length;
