/**
 * What D1 says when it is away for a moment and nothing is wrong with the
 * query: the sentences Cloudflare's "Debug D1" page lists as the ones a retry
 * is for. Any other D1 error (a missing table, a constraint, a wrong type) is
 * Keel's own defect and has no place here.
 */
export const D1_AWAY = [
  "Network connection lost.",
  "Replica disconnected from primary.",
  "Internal error in D1 DB storage caused object to be reset.",
  "Internal error while starting up D1 DB storage caused object to be reset.",
  "Cannot resolve D1 DB due to transient issue on remote node.",
  "Can't read from request stream because client disconnected.",
  "D1 DB storage operation exceeded timeout which caused object to be reset.",
  "D1 DB is overloaded. Requests queued for too long.",
  "D1 DB is overloaded. Too many requests queued.",
  "D1 DB's isolate exceeded its memory limit and was reset.",
  "D1 DB exceeded its CPU time limit and was reset.",
] as const;

/** How many causes under an error are read: enough for a wrapper or two, and an end to a cycle. */
const CAUSES = 4;

/**
 * Whether an error, or a cause under it, is D1 saying it is away. A sentence
 * is looked for inside the message: D1 writes `D1_ERROR: ` before it, and
 * whoever caught it may have wrapped it again.
 */
export function isD1Unavailable(error: unknown): boolean {
  let at = error;
  for (let depth = 0; depth <= CAUSES && at instanceof Error; depth += 1) {
    const { message } = at;
    if (D1_AWAY.some((sentence) => message.includes(sentence))) return true;
    at = at.cause;
  }
  return false;
}
