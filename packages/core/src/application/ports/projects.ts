import { Context, type Effect } from "effect";
import type { SubjectAnchors } from "../../domain/coordination/index.ts";
import type { IdempotencyConflict, AgentToken } from "../../domain/identity/index.ts";
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

/**
 * Whether the project's lane verifies each batch before it lands. `off` exists
 * only for S-0's negative control: operator-only, audited, set on the control
 * project alone. The lane then skips KeelVerify and stamps `verified: false`.
 */
export type Verification = "required" | "off";

/** Who may read the project: `public` lets anonymous readers in through the repo read API; `private` (the default) does not. */
export type Visibility = "private" | "public";

/** A project's settings, as its Project DO keeps them. `protectedPaths` is their one home. */
export interface ProjectSettings {
  readonly protectedPaths: readonly Glob[];
  readonly maxBatchSize: number;
  readonly verification: Verification;
  readonly visibility: Visibility;
}

/** Settings as an operator puts them, replacing the project's: an absent `verification` is `required`, an absent `visibility` `private`. */
export interface PutProjectSettings {
  readonly protectedPaths: readonly Glob[];
  readonly maxBatchSize: number;
  readonly verification?: Verification | undefined;
  readonly visibility?: Visibility | undefined;
}

/**
 * The way to the Project DOs (`project:<id>`). `create` is
 * idempotent by Idempotency-Key: the project id is derived from the operator
 * and the key, so a retry reaches the same DO, which replays its first answer
 * and refuses another body under the same key with IdempotencyConflict.
 * Precheck reads the protected globs from `settings`, and nothing else holds them.
 * `putSettings` replaces them under operator authority, which is instance-wide
 * at L1: the operator's own `prj` does not bind it. The Project DO audits every
 * changed field with ProjectSettingsChanged; an unchanged PUT commits nothing,
 * so a retry is a no-op by content. `requestId` keys the commit: the same id
 * with other settings is IdempotencyConflict.
 * `liveAnchors` is where the project's live changes anchor their subjects in
 * code, read from the Project DO's live index: Precheck's derivation
 * attributes a subject by these and nothing else. A project with no live
 * change, or none, answers nothing.
 */
export class Projects extends Context.Service<
  Projects,
  {
    readonly create: (
      principal: AgentToken,
      input: CreateProjectInput,
    ) => Effect.Effect<ProjectRecord, IdempotencyConflict | RepoNotFound>;
    readonly settings: (projectId: ProjectId) => Effect.Effect<ProjectSettings, ProjectNotFound>;
    readonly putSettings: (
      principal: AgentToken,
      projectId: ProjectId,
      settings: PutProjectSettings,
      requestId: string,
    ) => Effect.Effect<ProjectSettings, ProjectNotFound | IdempotencyConflict>;
    readonly liveAnchors: (projectId: ProjectId) => Effect.Effect<readonly SubjectAnchors[]>;
  }
>()("keel/Projects") {}
