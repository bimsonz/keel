import { ProjectNameTaken } from "@keeltown/core/domain/identity";
import { OrgId, ProjectId } from "@keeltown/core/kernel";
import { type ProjectPlace, ProjectOrgs } from "@keeltown/core/ports";
import { Clock as EffectClock, Effect, Layer, Option, Schema } from "effect";

/** A row of `projects`, decoded into its place. */
const PlaceRow = Schema.Struct({
  id: ProjectId,
  org_id: OrgId,
  name: Schema.String,
});

const decodePlace = Schema.decodeUnknownSync(PlaceRow);

function toPlace(row: unknown): ProjectPlace {
  const r = decodePlace(row);
  return { projectId: r.id, org: r.org_id, name: r.name };
}

const SELECT = "SELECT id, org_id, name FROM projects";

/**
 * Projects' places on D1's `projects` table, whose primary key and unique
 * (org_id, name) index decide every assignment: an insert that conflicts with
 * either writes nothing, and the project's own row then tells a repeat of its
 * place from a taken name or a move. A row that fails to decode is a defect.
 */
export function ProjectOrgsD1(db: D1Database) {
  const byId = (projectId: ProjectId) =>
    Effect.promise(() => db.prepare(`${SELECT} WHERE id = ?`).bind(projectId).first()).pipe(
      Effect.map((row) => (row === null ? Option.none() : Option.some(toPlace(row)))),
    );
  return Layer.succeed(
    ProjectOrgs,
    ProjectOrgs.of({
      assign: (place) =>
        Effect.gen(function* () {
          const name = place.name.toLowerCase();
          const at = yield* EffectClock.currentTimeMillis;
          const inserted = yield* Effect.promise(() =>
            db
              .prepare(
                "INSERT INTO projects (id, org_id, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
              )
              .bind(place.projectId, place.org, name, at)
              .run(),
          );
          if (inserted.meta.changes === 1) return;
          const held = yield* byId(place.projectId);
          const repeated =
            Option.isSome(held) && held.value.org === place.org && held.value.name === name;
          if (!repeated) yield* new ProjectNameTaken({ org: place.org, name });
        }),
      byId,
      byName: (org, name) =>
        Effect.promise(() =>
          db
            .prepare(`${SELECT} WHERE org_id = ? AND name = ?`)
            .bind(org, name.toLowerCase())
            .first(),
        ).pipe(Effect.map((row) => (row === null ? Option.none() : Option.some(toPlace(row))))),
      inOrg: (org) =>
        Effect.promise(() =>
          db.prepare(`${SELECT} WHERE org_id = ? ORDER BY name`).bind(org).all(),
        ).pipe(Effect.map(({ results }) => results.map(toPlace))),
    }),
  );
}
