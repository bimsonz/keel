import { Effect, Option } from "effect";
import {
  type Actor,
  actorId,
  IdempotencyConflict,
  type ProjectNameTaken,
} from "../../domain/identity/index.ts";
import type { ProjectNotFound } from "../../domain/integration/index.ts";
import { type NamespaceId, ProjectId } from "../../domain/kernel/index.ts";
import { projectRepos, type ProjectSource } from "../integration/index.ts";
import {
  type ProjectRecord,
  ProjectNamespaces,
  Projects,
  type ProjectSettings,
  type PutProjectSettings,
  type RepoNotFound,
} from "../ports/index.ts";
import { hashedIdBody } from "./hashed-id.ts";

/**
 * A new project in a namespace: trunk is forked from `source`, a template or
 * the trunk of a project the doorway let the actor fork.
 */
export interface NewProject {
  readonly namespace: NamespaceId;
  /** Its name in the namespace, held lower-case. */
  readonly name: string;
  /** Never a repo's name as the caller wrote it: `projectSource` reads that first. */
  readonly source: ProjectSource;
  readonly idempotencyKey: string;
}

/** The repo in the core namespace a source names: the template's own, or the project's trunk. */
const sourceRepo = (source: ProjectSource): string =>
  source._tag === "Template" ? source.repo : projectRepos(source.projectId).trunk.name;

/**
 * The project an actor's Idempotency-Key creates: derived from both, so a retry
 * reaches the same project and two actors' keys never meet.
 */
export const projectIdFor = (actor: Actor, idempotencyKey: string): ProjectId =>
  ProjectId.make(`prj_${hashedIdBody(`${actorId(actor)}\u0000${idempotencyKey}`)}`);

/**
 * Creates a project in `input.namespace`, which the doorway authorised the
 * actor in, from `input.source`, which the doorway let the actor fork when it
 * is a project. Its place comes first: the name, lower-case, must be free there
 * (ProjectNameTaken otherwise) before anything is made. Then its Project DO
 * forks trunk from the source, makes staging, the workspace mirror and pool,
 * and initialises trunk at the source's head, which reads the place. The id is
 * derived from the actor and the key, so a retry reaches the same place (a
 * no-op) and the same DO, which replays by key: a retry finishes a project
 * whose DO failed after its place was taken. The key reused for another
 * namespace or name is IdempotencyConflict.
 */
export const createProject: (
  actor: Actor,
  input: NewProject,
) => Effect.Effect<
  ProjectRecord,
  IdempotencyConflict | ProjectNameTaken | RepoNotFound,
  Projects | ProjectNamespaces
> = Effect.fn("coordination/createProject")(function* (actor: Actor, input: NewProject) {
  const { namespace, idempotencyKey } = input;
  const projectId = projectIdFor(actor, idempotencyKey);
  const name = input.name.toLowerCase();
  const places = yield* ProjectNamespaces;
  const placed = yield* places.byId(projectId);
  if (Option.isSome(placed) && (placed.value.namespace !== namespace || placed.value.name !== name))
    return yield* new IdempotencyConflict({ idempotencyKey });
  yield* places.assign({ projectId, namespace, name });
  const source = sourceRepo(input.source);
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
