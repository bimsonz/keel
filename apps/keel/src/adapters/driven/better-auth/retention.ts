/**
 * What keel.town's privacy notice says it keeps no longer: expired sessions,
 * sign-in codes and passkey challenges, device codes, and every invitation that
 * was answered or has lapsed. Raw D1 over Better Auth's tables, so the cron
 * never makes a Better Auth instance ([ba.per-request]).
 */

/** How many rows each table lost. */
export interface Purged {
  readonly sessions: number;
  readonly verifications: number;
  readonly deviceCodes: number;
  readonly invitations: number;
}

/**
 * Deletes in one batch. Better Auth writes its dates to D1 as ISO-8601 text
 * (`toISOString()`; each `[purge.*]` case reads it back), which sorts as it
 * reads, so each row is compared with `now` in that same text: in SQLite no
 * text is less than a number, so epoch milliseconds would delete nothing.
 */
export async function purgeExpired(db: D1Database, now: Date): Promise<Purged> {
  const at = now.toISOString();
  const [sessions, verifications, deviceCodes, invitations] = await db.batch([
    db.prepare(`DELETE FROM "session" WHERE "expiresAt" < ?1`).bind(at),
    db.prepare(`DELETE FROM "verification" WHERE "expiresAt" < ?1`).bind(at),
    db.prepare(`DELETE FROM "deviceCode" WHERE "expiresAt" < ?1`).bind(at),
    // Answered: accepted, rejected or canceled.
    db.prepare(`DELETE FROM "invitation" WHERE "expiresAt" < ?1 OR "status" <> 'pending'`).bind(at),
  ]);
  return {
    sessions: sessions?.meta.changes ?? 0,
    verifications: verifications?.meta.changes ?? 0,
    deviceCodes: deviceCodes?.meta.changes ?? 0,
    invitations: invitations?.meta.changes ?? 0,
  };
}
