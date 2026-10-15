// The questions waiting for whoever is signed in, across their projects: what
// Keel lists to them, and how the list is kept level with Keel's log. Keel
// decides whose a question is (the person its agent names first, then the
// namespace's maintainers); nothing here works that out.

import type { EscalationView } from "../contract/keel/index.ts";
import { backoffMs, pause, retryable } from "../source/backoff.ts";
import type { KeelDirectory } from "../source/types.ts";

/**
 * The entries of Keel's log that put a question to a person or close one: after any of them, what Keel lists may
 * differ. `EscalationWidened` is Keel putting a question, at thirty minutes, to its namespace's maintainers too.
 */
export const TURNS: ReadonlySet<string> = new Set([
  "EscalationRaised",
  "EscalationWidened",
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

/** Keel's word for the head of a feed: asked for as a cursor, it answers no entry and where to read on from. */
const HEAD = "end";

/**
 * Says when the list is to be read again, and never by the clock: it follows the reader's own feed, and calls
 * `again` when an entry that puts or closes a question arrives. The feed is joined at its head in one read,
 * with nothing of what came before, and `again` is called once there, for whatever came between the list's own
 * read and that one. It ends when `signal` aborts, or when Keel refuses the feed: a refusal is Keel's answer,
 * and asking again would not change it. Keel away for a moment is asked again, later each time.
 */
export async function followTurns(
  directory: Pick<KeelDirectory, "readOwnFeed">,
  again: () => void,
  signal: AbortSignal,
): Promise<void> {
  let cursor = HEAD;
  let level = false;
  let failures = 0;
  while (!signal.aborted) {
    const asked = Date.now();
    let failed: unknown;
    try {
      // oxlint-disable-next-line no-await-in-loop -- a long-poll loop reads one page after another by nature
      const page = await directory.readOwnFeed({
        cursor,
        ...(level ? { waitSec: 25 } : {}),
        signal,
      });
      failures = 0;
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
      // Keel's refusal is its answer, and asking again would not change it; Keel away for a moment, or a read
      // that dropped on the way, is asked again from the same place, later each time (backoff.ts).
      if (!retryable(error)) return;
      failures += 1;
      failed = error;
    }
    if (signal.aborted) return;
    // oxlint-disable-next-line no-await-in-loop -- as above
    if (failures > 0) await pause(backoffMs(failed, failures), signal);
    // An answer that came straight back with nothing new means the wait was not honoured: do not spin.
    // oxlint-disable-next-line no-await-in-loop -- as above
    else if (Date.now() - asked < 1_000) await pause(1_000, signal);
  }
}
