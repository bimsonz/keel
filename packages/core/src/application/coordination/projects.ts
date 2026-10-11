import type { Effect } from "effect";
import type { IdempotencyConflict, AgentToken } from "../../domain/identity/index.ts";
import type { ProjectNotFound } from "../../domain/integration/index.ts";
import type { ProjectId } from "../../domain/kernel/index.ts";
import {
  type CreateProjectInput,
  type ProjectRecord,
  Projects,
  type ProjectSettings,
  type PutProjectSettings,
  type RepoNotFound,
} from "../ports/index.ts";

/**
 * Creates a project in its Project DO: trunk forked from the source repo,
 * staging, the workspace mirror and pool, and trunk initialised at the source's
 * head. The doorways have already checked the operator scope.
 */
export const createProject: (
  principal: AgentToken,
  input: CreateProjectInput,
) => Effect.Effect<ProjectRecord, IdempotencyConflict | RepoNotFound, Projects> = (
  principal,
  input,
) => Projects.use((projects) => projects.create(principal, input));

/** The project's settings, as its Project DO holds them. The doorways have already checked the operator scope. */
export const getSettings: (
  projectId: ProjectId,
) => Effect.Effect<ProjectSettings, ProjectNotFound, Projects> = (projectId) =>
  Projects.use((projects) => projects.settings(projectId));

/**
 * Replaces the project's settings, audited by its Project DO. Operator
 * authority is instance-wide at L1, so the principal's own project does not
 * bind it; the doorways have already checked the operator scope.
 */
export const putSettings: (
  principal: AgentToken,
  projectId: ProjectId,
  settings: PutProjectSettings,
  requestId: string,
) => Effect.Effect<ProjectSettings, ProjectNotFound | IdempotencyConflict, Projects> = (
  principal,
  projectId,
  settings,
  requestId,
) => Projects.use((projects) => projects.putSettings(principal, projectId, settings, requestId));
