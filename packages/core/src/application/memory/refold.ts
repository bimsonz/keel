import { Option, Schema } from "effect";
import { EventEnvelope } from "../../domain/kernel/index.ts";
import type { EntityStore, Stored } from "../ports/index.ts";
import { foldLanding } from "./change-views.ts";
import { foldSubjectAnchors } from "./decision-index.ts";
import { feedHead, storedAt } from "./feed.ts";

/**
 * The feed's re-fold: the folds the Projector gained after its feed already
 * held events, run again over those events. A subject minted, or a change
 * landed, before the Projector folded anchors and landings was recorded on the
 * feed and folded into neither; the re-fold folds it, a step at a time, from
 * the feed's start up to where the feed ended when the re-fold began.
 * Everything recorded after that was folded as it arrived.
 */
export const REFOLD = {
  /** The position the re-fold is complete to. */
  refolded: { kind: "feed-refolded", id: "self" },
  /** The feed's head when the re-fold began: the re-fold goes no further. */
  until: { kind: "feed-refold-until", id: "self" },
} as const;

/** The positions one step of the re-fold reads at most, in one transaction. */
export const REFOLD_STEP = 5_000;

type Store = (typeof EntityStore)["Service"];

/** Where the re-fold stands: complete to `refolded`, and done once that reaches `until`. */
export interface RefoldMarks {
  readonly refolded: number;
  readonly until: number;
}

/** One step of the re-fold: the positions after `from` up to `to` were re-folded, and `level` once it reached `until`. */
export interface RefoldStep {
  readonly from: number;
  readonly to: number;
  readonly level: boolean;
}

/**
 * The folds the re-fold runs, by the stored event's type, and no other: each
 * puts the same rows however often it runs, so a position the receipt folded
 * and the re-fold folds again reads as it did.
 */
const REFOLDS: ReadonlyMap<string, (store: Store, event: EventEnvelope) => string | undefined> =
  new Map([
    ["SubjectMinted", foldSubjectAnchors],
    ["ChangeLanded", foldLanding],
  ]);

const decodeEnvelope = Schema.decodeUnknownOption(EventEnvelope);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const markOf = (store: Store, mark: { readonly kind: string; readonly id: string }): number => {
  const stored = store.get(mark.kind, mark.id);
  return typeof stored === "number" ? stored : 0;
};

/**
 * Where the re-fold stands, and where it ends. The first time it is asked,
 * that is the feed's head: whatever the feed holds then was recorded before
 * the folds the re-fold runs, and everything after is folded as it arrives.
 */
export function refoldUntil(store: Store): RefoldMarks {
  const until = store.get(REFOLD.until.kind, REFOLD.until.id);
  if (typeof until === "number") return { refolded: markOf(store, REFOLD.refolded), until };
  const head = feedHead(store);
  store.put(REFOLD.until.kind, REFOLD.until.id, head);
  return { refolded: markOf(store, REFOLD.refolded), until: head };
}

/** The fold the re-fold runs for a stored event, read by its `type` before anything is decoded. */
const refoldOf = (stored: Stored | undefined) => {
  const type = isRecord(stored) ? stored["type"] : undefined;
  return typeof type === "string" ? REFOLDS.get(type) : undefined;
};

/**
 * Re-folds the feed's next positions, at most `step` of them and never past
 * `until`, then moves the mark to the last one read. Synchronous, and run
 * inside the caller's transaction, so a step that dies part way commits
 * nothing: neither its rows nor its mark, and the next step reads the same
 * positions again. An event a fold cannot take is left unfolded, as a
 * receipt leaves it.
 */
export function refoldFeed(store: Store, step: number = REFOLD_STEP): RefoldStep {
  const from = markOf(store, REFOLD.refolded);
  const until = markOf(store, REFOLD.until);
  const to = Math.min(until, from + step);
  for (let at = from + 1; at <= to; at += 1) {
    const stored = storedAt(store, at);
    const fold = refoldOf(stored);
    if (fold === undefined) continue;
    const event = decodeEnvelope(stored);
    if (Option.isSome(event)) fold(store, event.value);
  }
  if (to > from) store.put(REFOLD.refolded.kind, REFOLD.refolded.id, to);
  return { from, to, level: to >= until };
}
