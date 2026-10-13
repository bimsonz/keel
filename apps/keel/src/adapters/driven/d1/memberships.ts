import { strongestRole } from "@keeltown/core/domain/identity";
import { Memberships } from "@keeltown/core/ports";
import { Clock, Effect, Layer, Schema } from "effect";
import { roleNames, rowBanHolds } from "./users.ts";

const BannedRow = Schema.Struct({
  banned: Schema.NullOr(Schema.Number),
  banExpires: Schema.NullOr(Schema.String),
});
const RoleRow = Schema.Struct({ role: Schema.String });

const decodeBanned = Schema.decodeUnknownSync(BannedRow);
const decodeRole = Schema.decodeUnknownSync(RoleRow);

/**
 * A sponsor's standing on Better Auth's `user` and `member` tables in D1, both
 * read in one batch: the strongest role any of the user's rows in the org
 * names, and its ban. In the namespace whose id is the user's own it is the
 * owner, by identity, for as long as the user is there: a member row naming a
 * person's namespace is never read.
 */
export function MembershipsD1(db: D1Database) {
  return Layer.succeed(
    Memberships,
    Memberships.of({
      standing: (userId, namespace) =>
        Effect.promise(() =>
          db.batch([
            db.prepare(`SELECT banned, banExpires FROM "user" WHERE id = ?`).bind(userId),
            db
              .prepare("SELECT role FROM member WHERE userId = ? AND organizationId = ?")
              .bind(userId, namespace),
          ]),
        ).pipe(
          Effect.zip(Clock.currentTimeMillis),
          Effect.map(([[users, members], now]) => {
            const user = users?.results[0];
            const inOrg = strongestRole(
              (members?.results ?? []).flatMap((member) => roleNames(decodeRole(member).role)),
            );
            const own = user === undefined ? undefined : ("owner" as const);
            const role = namespace === userId ? own : inOrg;
            return {
              userId,
              ...(role === undefined ? {} : { role }),
              suspended: user !== undefined && rowBanHolds(decodeBanned(user), now),
            };
          }),
        ),
    }),
  );
}
