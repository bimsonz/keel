import { OrgId } from "@keeltown/core/kernel";
import { type OrgRecord, Orgs } from "@keeltown/core/ports";
import { Effect, Layer, Option, Schema } from "effect";

/** The columns of Better Auth's `organization` row an OrgRecord needs. `suspended` is a flag: 0, 1 or null. */
const OrgRow = Schema.Struct({
  id: OrgId,
  slug: Schema.String,
  suspended: Schema.NullOr(Schema.Number),
});

const decodeOrg = Schema.decodeUnknownSync(OrgRow);

function toRecord(row: unknown): OrgRecord {
  const r = decodeOrg(row);
  return { org: r.id, name: r.slug, suspended: (r.suspended ?? 0) !== 0 };
}

/**
 * Orgs on Better Auth's `organization` table in D1. Its slug is stored
 * lower-case, so a name is lowered and matched exactly, on the slug's unique
 * index. A row that fails to decode is a defect, not a missing org.
 */
export function OrgsD1(db: D1Database) {
  const first = (where: string, value: string) =>
    Effect.promise(() =>
      db
        .prepare(`SELECT id, slug, suspended FROM organization WHERE ${where} = ?`)
        .bind(value)
        .first(),
    ).pipe(Effect.map((row) => (row === null ? Option.none() : Option.some(toRecord(row)))));
  return Layer.succeed(
    Orgs,
    Orgs.of({
      byId: (org) => first("id", org),
      byName: (name) => first("slug", name.toLowerCase()),
    }),
  );
}
