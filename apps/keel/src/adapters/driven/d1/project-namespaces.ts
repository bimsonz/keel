import { ProjectNameTaken } from "@keeltown/core/domain/identity";
import { NamespaceId, ProjectId } from "@keeltown/core/kernel";
import { type ProjectPlace, ProjectNamespaces } from "@keeltown/core/ports";
import { Clock as EffectClock, Effect, Layer, Option, Schema } from "effect";

/** A row of `projects`, decoded into its place. */
const PlaceRow = Schema.Struct({
  id: ProjectId,
  namespace_id: NamespaceId,
  name: Schema.String,
});

const decodePlace = Schema.decodeUnknownSync(PlaceRow);

function toPlace(row: unknown): ProjectPlace {
  const r = decodePlace(row);
  return { projectId: r.id, namespace: r.namespace_id, name: r.name };
}

const SELECT = "SELECT id, namespace_id, name FROM projects";

/**
 * Projects' places on D1's `projects` table, whose primary key and unique
 * (namespace_id, name) index decide every assignment: an insert that conflicts with
 * either writes nothing, and the project's own row then tells a repeat of its
 * place from a taken name or a move. A row that fails to decode is a defect.
 */
export function ProjectNamespacesD1(db: D1Database) {
  const byId = (projectId: ProjectId) =>
    Effect.promise(() => db.prepare(`${SELECT} WHERE id = ?`).bind(projectId).first()).pipe(
      Effect.map((row) => (row === null ? Option.none() : Option.some(toPlace(row)))),
    );
  return Layer.succeed(
    ProjectNamespaces,
    ProjectNamespaces.of({
      assign: (place) =>
        Effect.gen(function* () {
          const name = place.name.toLowerCase();
          const at = yield* EffectClock.currentTimeMillis;
          const inserted = yield* Effect.promise(() =>
            db
              .prepare(
                "INSERT INTO projects (id, namespace_id, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
              )
              .bind(place.projectId, place.namespace, name, at)
              .run(),
          );
          if (inserted.meta.changes === 1) return;
          const held = yield* byId(place.projectId);
          const repeated =
            Option.isSome(held) &&
            held.value.namespace === place.namespace &&
            held.value.name === name;
          if (!repeated) yield* new ProjectNameTaken({ org: place.namespace, name });
        }),
      byId,
      byName: (namespace, name) =>
        Effect.promise(() =>
          db
            .prepare(`${SELECT} WHERE namespace_id = ? AND name = ?`)
            .bind(namespace, name.toLowerCase())
            .first(),
        ).pipe(Effect.map((row) => (row === null ? Option.none() : Option.some(toPlace(row))))),
      inNamespace: (namespace) =>
        Effect.promise(() =>
          db.prepare(`${SELECT} WHERE namespace_id = ? ORDER BY name`).bind(namespace).all(),
        ).pipe(Effect.map(({ results }) => results.map(toPlace))),
      all: (after, limit) =>
        Effect.promise(() =>
          db
            .prepare(`${SELECT} WHERE id > ? ORDER BY id LIMIT ?`)
            .bind(after ?? "", limit)
            .all(),
        ).pipe(Effect.map(({ results }) => results.map(toPlace))),
    }),
  );
}
