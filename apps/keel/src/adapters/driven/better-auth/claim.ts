/**
 * The instance claim. An instance holds its future admin's handle
 * (KEEL_HELD_NAMES) until someone signs up with it by passkey, presenting the
 * one-time claim code in `Keel-Claim`. That makes them the instance admin and
 * the owner of the instance's own org, once: the claim is spent as soon as any
 * user is admin. The Worker holds only the code's SHA-256 (KEEL_CLAIM_DIGEST),
 * and Keel never logs the header.
 */
import { INSTANCE_ORG } from "./names.ts";

/** The request header a passkey sign-up presents the claim code in, on both of its calls. */
export const CLAIM_HEADER = "keel-claim";

/** A `user` row holding the admin role. Better Auth keeps a user's roles comma-separated. */
const ADMIN = `(',' || role || ',') LIKE '%,admin,%'`;

/**
 * Whether `code` is the claim code: its SHA-256 equals `digest` (lower-case
 * hex), compared in constant time. Without a digest no code is.
 */
export async function isClaimCode(code: string, digest: string | undefined): Promise<boolean> {
  if (digest === undefined || !/^[0-9a-f]{64}$/i.test(digest)) return false;
  const presented = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)),
  );
  const expected = Uint8Array.from(digest.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  return crypto.subtle.timingSafeEqual(presented, expected);
}

/** Whether the claim is spent: some user is the instance admin already. */
export async function claimSpent(db: D1Database): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS one FROM user WHERE ${ADMIN} LIMIT 1`).first()) !== null;
}

/**
 * Completes a claim in one batch, and only while no user is admin: `userId`
 * takes `handle` and the admin role, and org `keel` is made with it as its
 * owner. Answers false, having changed nothing, when another claim got there
 * first. Dates are stored as Better Auth stores them on D1, as ISO strings.
 */
export async function completeClaim(
  db: D1Database,
  claim: {
    readonly userId: string;
    readonly handle: string;
    readonly newId: (input: { model: string }) => string;
  },
): Promise<boolean> {
  const at = new Date().toISOString();
  const org = claim.newId({ model: "organization" });
  const [took] = await db.batch([
    db
      .prepare(
        `UPDATE user SET username = ?2, displayUsername = ?2, role = 'admin', updatedAt = ?3 WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM user WHERE ${ADMIN})`,
      )
      .bind(claim.userId, claim.handle, at),
    db
      .prepare(
        `INSERT INTO organization (id, name, slug, createdAt, suspended) SELECT ?2, ?3, ?3, ?4, 0 WHERE EXISTS (SELECT 1 FROM user WHERE id = ?1 AND ${ADMIN}) AND NOT EXISTS (SELECT 1 FROM organization WHERE slug = ?3)`,
      )
      .bind(claim.userId, org, INSTANCE_ORG, at),
    db
      .prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt) SELECT ?3, ?2, ?1, 'owner', ?4 WHERE EXISTS (SELECT 1 FROM organization WHERE id = ?2)`,
      )
      .bind(claim.userId, org, claim.newId({ model: "member" }), at),
  ]);
  return took?.meta.changes === 1;
}
