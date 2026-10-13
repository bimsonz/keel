import { Handle, ProjectNameTaken, Visibility } from "@keeltown/core/domain/identity";
import { NamespaceId, NamespaceKind, ProjectId } from "@keeltown/core/kernel";
import { type ListedProject, type ProjectPlace, ProjectNamespaces } from "@keeltown/core/ports";
import { Clock as EffectClock, Effect, Layer, Option, Schema } from "effect";
import { rowBanHolds } from "./users.ts";

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
 * A listed project's row: its place and mirrored visibility, beside what its
 * namespace's account says of it (an org's `suspended` flag, a person's ban).
 */
const ListedRow = Schema.Struct({
  id: ProjectId,
  namespace_id: NamespaceId,
  name: Schema.String,
  visibility: Visibility,
  handle: Handle,
  kind: NamespaceKind,
  suspended: Schema.NullOr(Schema.Number),
  banned: Schema.NullOr(Schema.Number),
  banExpires: Schema.NullOr(Schema.String),
});

const decodeListed = Schema.decodeUnknownSync(ListedRow);

function toListed(row: unknown, now: number): ListedProject {
  const r = decodeListed(row);
  return {
    projectId: r.id,
    namespace: r.namespace_id,
    name: r.name,
    visibility: r.visibility,
    handle: r.handle,
    kind: r.kind,
    suspended: r.kind === "user" ? rowBanHolds(r, now) : (r.suspended ?? 0) !== 0,
  };
}

/**
 * A page of projects with each one's namespace and its account, as
 * `NamespacesD1` reads a namespace: the join leaves out a project whose org or
 * person is gone. `from` names the projects table, and the index when one
 * serves; `shown` narrows it.
 */
const listed = (from: string, shown: string) => `SELECT p.id, p.namespace_id, p.name, p.visibility,
  n.handle, n.kind, o.suspended, u.banned, u.banExpires
  FROM ${from}
  JOIN namespaces n ON n.id = p.namespace_id
  LEFT JOIN organization o ON n.kind = 'org' AND o.id = n.id
  LEFT JOIN "user" u ON n.kind = 'user' AND u.id = n.id
  WHERE ${shown} AND p.id > ?
    AND (n.kind = 'agent' OR o.id IS NOT NULL OR u.id IS NOT NULL)
  ORDER BY p.id LIMIT ?`;

/** A visitor's page: the public projects alone, read from the index that holds only them. */
const PUBLIC = listed("projects p INDEXED BY projects_public", "p.visibility = 'public'");

/**
 * An audience's page: what is public, what is in one of its namespaces (bound
 * as one JSON array, so their number never meets D1's limit on bound values),
 * and its one project.
 */
const SHOWN = listed(
  "projects p",
  "(p.visibility = 'public' OR p.namespace_id IN (SELECT value FROM json_each(?)) OR p.id = ?)",
);

/**
 * Projects' places on D1's `projects` table, whose primary key and unique
 * (namespace_id, name) index decide every assignment: an insert that conflicts with
 * either writes nothing, and the project's own row then tells a repeat of its
 * place from a taken name or a move. A row that fails to decode is a defect.
 *
 * The mirrored visibility is written by `visibility` alone, guarded by
 * `visibility_seq` (migration 0014); a row is `private` as it is inserted.
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
      release: (projectId) =>
        Effect.promise(() =>
          db.prepare("DELETE FROM projects WHERE id = ?").bind(projectId).run(),
        ).pipe(Effect.asVoid),
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
      shownTo: (audience, after, limit) =>
        Effect.promise(() =>
          audience.namespaces.length === 0 && audience.project === undefined
            ? db
                .prepare(PUBLIC)
                .bind(after ?? "", limit)
                .all()
            : db
                .prepare(SHOWN)
                .bind(
                  JSON.stringify(audience.namespaces),
                  audience.project ?? null,
                  after ?? "",
                  limit,
                )
                .all(),
        ).pipe(
          Effect.zip(EffectClock.currentTimeMillis),
          Effect.map(([{ results }, now]) => results.map((row) => toListed(row, now))),
        ),
      visibility: (projectId, visibility, seq) =>
        Effect.promise(() =>
          db
            .prepare(
              "UPDATE projects SET visibility = ?, visibility_seq = ? WHERE id = ? AND visibility_seq < ?",
            )
            .bind(visibility, seq, projectId, seq)
            .run(),
        ).pipe(Effect.asVoid),
    }),
  );
}
