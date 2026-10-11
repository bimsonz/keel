import { Context, type Effect } from "effect";
import type { IdempotencyConflict, Principal } from "../../domain/identity/index.ts";
import type { ProjectNotFound } from "../../domain/integration/index.ts";
import type { Glob, Instant, ProjectId } from "../../domain/kernel/index.ts";
import type { RepoNotFound } from "./code-host.ts";

/** A project as its operator sees it. */
export interface ProjectRecord {
  readonly id: ProjectId;
  readonly name: string;
  readonly createdAt: Instant;
}

export interface CreateProjectInput {
  readonly name: string;
  /** The repository in the core namespace that trunk is forked from. */
  readonly source: string;
  readonly idempotencyKey: string;
}

/** A project's settings, as its Project DO keeps them. `protectedPaths` is their one home. */
export interface ProjectSettings {
  readonly protectedPaths: readonly Glob[];
  readonly maxBatchSize: number;
}

/**
 * The way to the Project DOs (`project:<id>`). `create` is
 * idempotent by Idempotency-Key: the project id is derived from the operator
 * and the key, so a retry reaches the same DO, which replays its first answer
 * and refuses another body under the same key with IdempotencyConflict.
 * Precheck reads the protected globs from `settings`, and nothing else holds them.
 */
export class Projects extends Context.Service<
  Projects,
  {
    readonly create: (
      principal: Principal,
      input: CreateProjectInput,
    ) => Effect.Effect<ProjectRecord, IdempotencyConflict | RepoNotFound>;
    readonly settings: (projectId: ProjectId) => Effect.Effect<ProjectSettings, ProjectNotFound>;
  }
>()("keel/Projects") {}
