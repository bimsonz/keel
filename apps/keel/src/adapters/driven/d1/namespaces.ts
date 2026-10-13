import { Handle } from "@keeltown/core/domain/identity";
import { NamespaceId, NamespaceKind } from "@keeltown/core/kernel";
import { type NamespaceRecord, Namespaces } from "@keeltown/core/ports";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { rowBanHolds } from "./users.ts";

/**
 * A `namespaces` row beside what its account says of it: an org's `suspended`
 * flag (0, 1 or null), a person's ban, and whether the account is still there.
 */
const NamespaceRow = Schema.Struct({
  id: NamespaceId,
  handle: Handle,
  kind: NamespaceKind,
  suspended: Schema.NullOr(Schema.Number),
  banned: Schema.NullOr(Schema.Number),
  banExpires: Schema.NullOr(Schema.String),
  held: Schema.Number,
});

const decodeRow = Schema.decodeUnknownSync(NamespaceRow);

function toRecord(row: unknown, now: number): Option.Option<NamespaceRecord> {
  const r = decodeRow(row);
  if (r.held === 0) return Option.none();
  return Option.some({
    namespace: r.id,
    handle: r.handle,
    kind: r.kind,
    suspended: r.kind === "user" ? rowBanHolds(r, now) : (r.suspended ?? 0) !== 0,
  });
}

/**
 * A namespace with its account, in one query. An org's account is Better
 * Auth's `organization` row and a person's its `user` row; an agent's
 * namespace stands on its own row.
 */
const SELECT = `SELECT n.id, n.handle, n.kind, o.suspended, u.banned, u.banExpires,
  (n.kind = 'agent' OR o.id IS NOT NULL OR u.id IS NOT NULL) AS held
  FROM namespaces n
  LEFT JOIN organization o ON n.kind = 'org' AND o.id = n.id
  LEFT JOIN "user" u ON n.kind = 'user' AND u.id = n.id`;

/**
 * Namespaces on D1's `namespaces` table, whose rows the database writes
 * (migration 0010's triggers). A handle is stored lower-case, so one is lowered
 * and matched exactly, on its unique index. The row of an org or a person that
 * was deleted stays, so its handle is never issued twice, and answers none. A
 * row that fails to decode is a defect, not a missing namespace.
 */
export function NamespacesD1(db: D1Database) {
  const first = (where: string, value: string) =>
    Effect.promise(() => db.prepare(`${SELECT} WHERE ${where} = ?`).bind(value).first()).pipe(
      Effect.zip(Clock.currentTimeMillis),
      Effect.map(([row, now]) => (row === null ? Option.none() : toRecord(row, now))),
    );
  return Layer.succeed(
    Namespaces,
    Namespaces.of({
      byId: (namespace) => first("n.id", namespace),
      byHandle: (handle) => first("n.handle", handle.toLowerCase()),
    }),
  );
}
