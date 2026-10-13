import { Context, type Effect } from "effect";
import type { SubjectAnchors } from "../../domain/coordination/index.ts";
import type { Actor, IdempotencyConflict, QuotaExceeded } from "../../domain/identity/index.ts";
import type { ProjectNotFound } from "../../domain/integration/index.ts";
import type { Glob, Instant, ProjectId } from "../../domain/kernel/index.ts";
import type { ImportRefused, RepoNotFound } from "./code-host.ts";
import type { ImportTooLarge } from "./trunks.ts";

/** A project as its operator sees it. */
export interface ProjectRecord {
  readonly id: ProjectId;
  readonly name: string;
  readonly createdAt: Instant;
}

/** A template, by its repo's name in the core namespace. */
export interface TemplateSource {
  readonly _tag: "Template";
  readonly repo: string;
}

/** Another project's trunk: a fork, which the policy decides on that project. */
export interface TrunkSource {
  readonly _tag: "Project";
  readonly projectId: ProjectId;
}

/** Nothing to start from: Keel writes the project's first commit itself. */
export interface EmptySource {
  readonly _tag: "Empty";
}

/**
 * A public Git repository, by the URL `importUrl` admitted. `ref` is the
 * upstream's branch to take, as `importRef` admitted it; its default branch
 * when absent.
 */
export interface ImportSource {
  readonly _tag: "Import";
  readonly url: string;
  readonly ref?: string | undefined;
}

/** Where a new project's trunk starts. Never a repo's name as a caller wrote it: the doorway reads that first. */
export type ProjectSource = EmptySource | ImportSource | TrunkSource | TemplateSource;

/**
 * A start that made no project, and left no repo behind: the template or the
 * project to fork is not there (RepoNotFound), the code host imported nothing
 * from the URL (ImportRefused), or the imported history is over what its
 * namespace has left (QuotaExceeded) or over what one relay carries
 * (ImportTooLarge).
 */
export type ProjectStartRefused = RepoNotFound | ImportRefused | QuotaExceeded | ImportTooLarge;

/** A project to create, its id derived from its creator and the Idempotency-Key. */
export interface CreateProjectInput {
  readonly projectId: ProjectId;
  /** Its name in its org, lower-case. */
  readonly name: string;
  /** Where trunk starts. */
  readonly source: ProjectSource;
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
 * The way to the Project DOs (`project:<id>`). `create` is idempotent by
 * Idempotency-Key: the caller derives the project id from the actor and the
 * key, so a retry reaches the same DO, which replays its first answer and
 * refuses another body under the same key with IdempotencyConflict. The DO
 * records the actor's id as the project's creator.
 * Precheck reads the protected globs from `settings`, and nothing else holds them.
 * `putSettings` replaces them as the actor, whom the doorway authorised. The
 * Project DO audits every changed field with ProjectSettingsChanged; an
 * unchanged PUT commits nothing, so a retry is a no-op by content.
 * `requestId` keys the commit: the same id with other settings is
 * IdempotencyConflict.
 * `liveAnchors` is where the project's live changes anchor their subjects in
 * code, read from the Project DO's live index: Precheck's derivation
 * attributes a subject by these and nothing else. A project with no live
 * change, or none, answers nothing.
 */
export class Projects extends Context.Service<
  Projects,
  {
    readonly create: (
      actor: Actor,
      input: CreateProjectInput,
    ) => Effect.Effect<ProjectRecord, IdempotencyConflict | ProjectStartRefused>;
    readonly settings: (projectId: ProjectId) => Effect.Effect<ProjectSettings, ProjectNotFound>;
    readonly putSettings: (
      actor: Actor,
      projectId: ProjectId,
      settings: PutProjectSettings,
      requestId: string,
    ) => Effect.Effect<ProjectSettings, ProjectNotFound | IdempotencyConflict>;
    readonly liveAnchors: (projectId: ProjectId) => Effect.Effect<readonly SubjectAnchors[]>;
  }
>()("keel/Projects") {}
