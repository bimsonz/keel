// How the console asks Keel again after a read that failed: never sooner than Keel said, and later each time it
// fails again, so that a Keel struggling for a moment (its database overloaded, a deploy) is not asked harder by
// every reader at once. One rule for every read the console repeats: the log's long-poll, its page reads, and
// the reader's own feed.

import { KeelRefused } from "./types.ts";

/** The longest the console waits between two tries of its own reckoning. */
export const LONGEST_WAIT_MS = 30_000;

/** The longest wait Keel's own Retry-After is taken at: past that, the console asks again anyway. */
const LONGEST_ASKED_MS = 5 * 60_000;

/** The first wait, doubled each time the read fails again. */
const FIRST_WAIT_MS = 1_000;

/**
 * Whether a failed read is worth asking again: Keel was away for a moment (it answered 5xx, 429 or 408), or the
 * read dropped on the way and Keel answered nothing. Any other refusal is Keel's answer, and asking again would
 * not change it.
 */
export function retryable(error: unknown): boolean {
  if (!(error instanceof KeelRefused))
    return !(error instanceof DOMException && error.name === "AbortError");
  return error.status >= 500 || error.status === 429 || error.status === 408;
}

/**
 * How long to wait before asking again, after `failures` failed tries in a row (1 for the first). It doubles from
 * a second, up to thirty, with equal jitter so that readers who failed together do not ask together; and it is
 * never sooner than Keel's own Retry-After, where it gave one.
 */
export function backoffMs(
  error: unknown,
  failures: number,
  random: () => number = Math.random,
): number {
  const step = Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** Math.max(0, failures - 1));
  const jittered = step / 2 + (random() * step) / 2;
  const asked =
    error instanceof KeelRefused && error.retryAfterMs !== undefined
      ? Math.min(error.retryAfterMs, LONGEST_ASKED_MS)
      : 0;
  return Math.max(asked, jittered);
}

/** Waits `ms`, or less where `signal` aborts first. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * What Keel said about when to ask again: its Retry-After header, in seconds or as a date, else the
 * `retryAfterMs` of its problem. Undefined where it said neither.
 */
export function retryAfterOf(
  header: string | null,
  problem: { retryAfterMs?: unknown },
  now: number = Date.now(),
): number | undefined {
  if (header !== null && header.trim() !== "") {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const { retryAfterMs } = problem;
  return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? retryAfterMs
    : undefined;
}
