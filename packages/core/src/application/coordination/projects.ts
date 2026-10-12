import { Effect, Option } from "effect";
import {
  type Actor,
  actorId,
  IdempotencyConflict,
  type ProjectNameTaken,
} from "../../domain/identity/index.ts";
import type { ProjectNotFound } from "../../domain/integration/index.ts";
import { type OrgId, ProjectId } from "../../domain/kernel/index.ts";
import {
  type ProjectRecord,
  ProjectOrgs,
  Projects,
  type ProjectSettings,
  type PutProjectSettings,
  type RepoNotFound,
} from "../ports/index.ts";
import { hashedIdBody } from "./hashed-id.ts";

/** A new project in an org: trunk is forked from `source`, a repo in the core namespace. */
export interface NewProject {
  readonly org: OrgId;
  /** Its name in the org, held lower-case. */
  readonly name: string;
  readonly source: string;
  readonly idempotencyKey: string;
}

/**
 * The project an actor's Idempotency-Key creates: derived from both, so a retry
 * reaches the same project and two actors' keys never meet.
 */
export const projectIdFor = (actor: Actor, idempotencyKey: string): ProjectId =>
  ProjectId.make(`prj_${hashedIdBody(`${actorId(actor)}\u0000${idempotencyKey}`)}`);

/**
 * Creates a project in `input.org`, which the doorway authorised the actor in.
 * Its place comes first: the name, lower-case, must be free in the org
 * (ProjectNameTaken otherwise) before anything is made. Then its Project DO
 * forks trunk from the source, makes staging, the workspace mirror and pool,
 * and initialises trunk at the source's head, which reads the place. The id is
 * derived from the actor and the key, so a retry reaches the same place (a
 * no-op) and the same DO, which replays by key: a retry finishes a project
 * whose DO failed after its place was taken. The key reused for another org
 * or name is IdempotencyConflict.
 */
export const createProject: (
  actor: Actor,
  input: NewProject,
) => Effect.Effect<
  ProjectRecord,
  IdempotencyConflict | ProjectNameTaken | RepoNotFound,
  Projects | ProjectOrgs
> = Effect.fn("coordination/createProject")(function* (actor: Actor, input: NewProject) {
  const { org, source, idempotencyKey } = input;
  const projectId = projectIdFor(actor, idempotencyKey);
  const name = input.name.toLowerCase();
  const places = yield* ProjectOrgs;
  const placed = yield* places.byId(projectId);
  if (Option.isSome(placed) && (placed.value.org !== org || placed.value.name !== name))
    return yield* new IdempotencyConflict({ idempotencyKey });
  yield* places.assign({ projectId, org, name });
  return yield* (yield* Projects).create(actor, { projectId, name, source, idempotencyKey });
});

/** The project's settings, as its Project DO holds them. */
export const getSettings: (
  projectId: ProjectId,
) => Effect.Effect<ProjectSettings, ProjectNotFound, Projects> = (projectId) =>
  Projects.use((projects) => projects.settings(projectId));

/** Replaces the project's settings, audited by its Project DO under the actor's id. */
export const putSettings: (
  actor: Actor,
  projectId: ProjectId,
  settings: PutProjectSettings,
  requestId: string,
) => Effect.Effect<ProjectSettings, ProjectNotFound | IdempotencyConflict, Projects> = (
  actor,
  projectId,
  settings,
  requestId,
) => Projects.use((projects) => projects.putSettings(actor, projectId, settings, requestId));
