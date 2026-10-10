import type { Effect } from "effect";
import type { IdempotencyConflict, Principal } from "../../domain/identity/index.ts";
import {
  type CreateProjectInput,
  type ProjectRecord,
  Projects,
  type RepoNotFound,
} from "../ports/index.ts";

/**
 * Creates a project in its Project DO: trunk forked from the source repo,
 * staging, the workspace mirror and pool, and trunk initialised at the source's
 * head. The doorways have already checked the operator scope.
 */
export const createProject: (
  principal: Principal,
  input: CreateProjectInput,
) => Effect.Effect<ProjectRecord, IdempotencyConflict | RepoNotFound, Projects> = (
  principal,
  input,
) => Projects.use((projects) => projects.create(principal, input));
