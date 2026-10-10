import { Context, type Effect } from "effect";
import type { IdempotencyConflict, Principal } from "../../domain/identity/index.ts";
import type { Instant, ProjectId } from "../../domain/kernel/index.ts";
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

/**
 * The isolate's way to the Project DOs (`project:<id>`). `create` is
 * idempotent by Idempotency-Key: the project id is derived from the operator
 * and the key, so a retry reaches the same DO, which replays its first answer
 * and refuses another body under the same key with IdempotencyConflict.
 */
export class Projects extends Context.Service<
  Projects,
  {
    readonly create: (
      principal: Principal,
      input: CreateProjectInput,
    ) => Effect.Effect<ProjectRecord, IdempotencyConflict | RepoNotFound>;
  }
>()("keel/Projects") {}
