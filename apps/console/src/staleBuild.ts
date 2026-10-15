// A page loaded before a deploy asks, later, for a file of its build that the new build has not: the import fails
// and the page would draw nothing. It loads itself again, once, and so reads the new build. A second failure soon
// after is not a deploy's, and is left to show.

/** How long after such a reload another missing file is taken as the page's own fault. */
export const AGAIN_MS = 30_000;
const STAMP = "keel:reloaded-for-a-missing-file";

/**
 * Loads the page again where no such reload was made in the last `AGAIN_MS`, and says whether it did. Without
 * somewhere to keep when it last did, it never does, since it could not tell a deploy from a loop.
 */
export function reloadOnce(
  storage: () => Pick<Storage, "getItem" | "setItem">,
  now: number,
  reload: () => void,
): boolean {
  try {
    const kept = storage();
    const last = Number(kept.getItem(STAMP) ?? Number.NEGATIVE_INFINITY);
    if (now - last < AGAIN_MS) return false;
    kept.setItem(STAMP, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}
