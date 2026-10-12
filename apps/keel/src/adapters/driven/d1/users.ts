import { banHolds, Handle, type Membership, strongestRole } from "@keeltown/core/domain/identity";
import { OrgId, UserId } from "@keeltown/core/kernel";
import { Users } from "@keeltown/core/ports";
import { Clock, Effect, Layer, Option, Schema } from "effect";

/** The names in a Better Auth role column, which holds several comma-separated. */
export function roleNames(column: string | null): readonly string[] {
  return (column ?? "").split(",").map((name) => name.trim());
}

/**
 * The columns of Better Auth's `user` row a principal needs. `banned` is a
 * flag: 0, 1 or null; `banExpires` an ISO date, or null for a ban without end.
 */
const UserRow = Schema.Struct({
  id: UserId,
  username: Schema.NullOr(Handle),
  banned: Schema.NullOr(Schema.Number),
  banExpires: Schema.NullOr(Schema.String),
});

/** Whether a row's ban suspends its user at `now`. */
export const rowBanHolds = (
  row: { readonly banned: number | null; readonly banExpires: string | null },
  now: number,
): boolean =>
  banHolds(
    (row.banned ?? 0) !== 0,
    row.banExpires === null ? undefined : new Date(row.banExpires),
    now,
  );

const MemberRow = Schema.Struct({ org: OrgId, role: Schema.String });

const decodeUser = Schema.decodeUnknownSync(UserRow);
const decodeMember = Schema.decodeUnknownSync(MemberRow);

/**
 * Users on Better Auth's `user` and `member` tables in D1, both read in one
 * batch. A row that fails to decode is a defect.
 */
export function UsersD1(db: D1Database) {
  return Layer.succeed(
    Users,
    Users.of({
      principal: (userId) =>
        Effect.promise(() =>
          db.batch([
            db
              .prepare(`SELECT id, username, banned, banExpires FROM "user" WHERE id = ?`)
              .bind(userId),
            db
              .prepare(
                "SELECT organizationId AS org, role FROM member WHERE userId = ? ORDER BY organizationId",
              )
              .bind(userId),
          ]),
        ).pipe(
          Effect.zip(Clock.currentTimeMillis),
          Effect.map(([[users, members], now]) => {
            const row = users?.results[0];
            if (row === undefined) return Option.none();
            const user = decodeUser(row);
            const memberships = (members?.results ?? []).flatMap((member): Membership[] => {
              const { org, role } = decodeMember(member);
              const strongest = strongestRole(roleNames(role));
              return strongest === undefined ? [] : [{ org, role: strongest }];
            });
            return Option.some({
              _tag: "User" as const,
              userId: user.id,
              ...(user.username === null ? {} : { handle: user.username }),
              suspended: rowBanHolds(user, now),
              memberships,
            });
          }),
        ),
    }),
  );
}
