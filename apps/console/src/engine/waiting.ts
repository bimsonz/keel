// The questions waiting for whoever is signed in, across their projects: what
// Keel lists to them, and how the list is kept level with Keel's log. Keel
// decides whose a question is (the person its agent names first, then the
// namespace's maintainers); nothing here works that out.

import type { EscalationView } from "../contract/keel/index.ts";
import { type KeelDirectory, KeelRefused } from "../source/types.ts";

/** The entries of Keel's log that put a question to a person or close one: after any of them, what Keel lists may differ. */
export const TURNS: ReadonlySet<string> = new Set([
  "EscalationRaised",
  "EscalationWithdrawn",
  "RulingGiven",
  "ConflictResolved",
]);

/** One question as the home lists it: Keel's own label, words and place for it. */
export interface WaitingRow {
  id: string;
  label: string;
  question: string;
  namespace: string;
  project: string;
  category: EscalationView["category"];
  raisedAt: string;
}

/** The questions still open, in the order Keel listed them. One answered or withdrawn since is not waiting. */
export function waitingRows(listed: readonly EscalationView[]): WaitingRow[] {
  return listed
    .filter((item) => item.state === "open")
    .map((item) => ({
      id: item.id,
      label: item.label,
      question: item.question,
      namespace: item.project.namespace,
      project: item.project.name,
      category: item.category,
      raisedAt: item.raisedAt,
    }));
}

/** How long a read that failed on the way is left before it is asked again, at most. */
const LONGEST_PAUSE_MS = 30_000;

/** Keel's word for the head of a feed: asked for as a cursor, it answers no entry and where to read on from. */
const HEAD = "end";

/**
 * Says when the list is to be read again, and never by the clock: it follows the reader's own feed, and calls
 * `again` when an entry that puts or closes a question arrives. The feed is joined at its head in one read,
 * with nothing of what came before, and `again` is called once there, for whatever came between the list's own
 * read and that one. It ends when `signal` aborts, or when Keel refuses the feed: a refusal is Keel's answer,
 * and asking again would not change it.
 */
export async function followTurns(
  directory: Pick<KeelDirectory, "readOwnFeed">,
  again: () => void,
  signal: AbortSignal,
): Promise<void> {
  let cursor = HEAD;
  let level = false;
  let pause = 1_000;
  while (!signal.aborted) {
    const asked = Date.now();
    let dropped = false;
    try {
      // oxlint-disable-next-line no-await-in-loop -- a long-poll loop reads one page after another by nature
      const page = await directory.readOwnFeed({
        cursor,
        ...(level ? { waitSec: 25 } : {}),
        signal,
      });
      pause = 1_000;
      const movedOn = page.nextCursor !== cursor;
      cursor = page.nextCursor;
      if (!level) {
        // Keel has said where its log ends now. Everything after is waited for from there.
        level = true;
        again();
        continue;
      }
      if (page.items.some((type) => TURNS.has(type))) again();
      if (movedOn) continue;
    } catch (error) {
      if (error instanceof KeelRefused) return;
      // The read dropped on the way. It is asked again from the same place, after a pause that grows.
      dropped = true;
    }
    // An answer that came straight back with nothing new means the wait was not honoured: do not spin.
    if (!signal.aborted && (dropped || Date.now() - asked < 1_000)) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      await new Promise((resolve) => setTimeout(resolve, pause));
      if (dropped) pause = Math.min(pause * 2, LONGEST_PAUSE_MS);
    }
  }
}
