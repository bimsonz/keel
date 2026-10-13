import { DerivedEffect, Intent, SubjectKey } from "@keeltown/core/domain/coordination";
import { IdempotencyConflict } from "@keeltown/core/domain/identity";
import { ProjectNotFound } from "@keeltown/core/domain/integration";
import {
  Actor,
  Anchor,
  ChangeId,
  Glob,
  InstantSchema,
  ProjectId,
  UserId,
} from "@keeltown/core/kernel";
import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";
import { RepoRef } from "./workspace-pool.ts";

/** Whether the project's lane verifies each batch: `off` only on S-0's control project. */
export const Verification = Schema.Literals(["required", "off"]);

/** Who may read the project: `public` lets anonymous readers in; `private` is the default. */
export const Visibility = Schema.Literals(["private", "public"]);

/** The project's settings as the Project DO answers them: `verification` and `visibility` always present. */
export const ProjectSettings = Schema.Struct({
  protectedPaths: Schema.Array(Glob),
  maxBatchSize: Schema.Int,
  verification: Verification,
  visibility: Visibility,
});

/**
 * Replace the project's settings (an absent `verification` is `required`, an
 * absent `visibility` `private`). `by` is the actor's id, and `actor` the same
 * actor as the envelope names it (`user:<id>`). The Project DO commits one
 * ProjectSettingsChanged naming every changed field, with `by`, under that
 * actor; an unchanged PUT commits nothing. `requestId` keys the commit: a replay answers the settings
 * as they stand, and the same id with other settings is IdempotencyConflict.
 */
export const PutSettingsCommand = Schema.Struct({
  projectId: ProjectId,
  settings: Schema.Struct({
    protectedPaths: Schema.Array(Glob),
    maxBatchSize: Schema.Int,
    verification: Schema.optional(Verification),
    visibility: Schema.optional(Visibility),
  }),
  by: Schema.NonEmptyString,
  actor: Actor,
  requestId: Schema.NonEmptyString,
});

/**
 * Create the project this DO is named for. The isolate derives `projectId`
 * from the actor and the Idempotency-Key, so a retry reaches the same DO,
 * which replays by `idempotencyKey` and refuses another body (`fingerprint`)
 * with IdempotencyConflict. `by` is the person creating it; the commit's actor
 * is `user:<by>`. Trunk is forked from `source`, a repo in the core
 * namespace; staging is forked from trunk; the per-project mirror is created
 * empty in the workspace namespace and trunk's head is pushed into it; then the
 * pool is configured and trunk is initialised at that head.
 */
export const CreateProjectCommand = Schema.Struct({
  projectId: ProjectId,
  name: Schema.NonEmptyString,
  /** The repo in the core namespace that trunk is forked from. */
  source: Schema.NonEmptyString,
  by: UserId,
  idempotencyKey: Schema.String,
  fingerprint: Schema.String,
});

export const ProjectView = Schema.Struct({
  id: ProjectId,
  name: Schema.NonEmptyString,
  createdAt: InstantSchema,
});

/**
 * CodeHost's RepoNotFound, by shape: this folder cannot import the ports (rule
 * R15), so the DO answers the port's error as is and the caller rebuilds it.
 */
export const RepoNotFound = Schema.TaggedStruct("RepoNotFound", { repo: RepoRef });

/** One live change in the project's index: its current intent and the effects last derived for it. */
export const LiveChangeView = Schema.Struct({
  id: ChangeId,
  intent: Intent,
  derived: Schema.Array(DerivedEffect),
});

/** A live subject and the code it is anchored to: the domain's `SubjectAnchors`, as it crosses RPC. */
export const SubjectAnchorsView = Schema.Struct({
  subject: SubjectKey,
  anchors: Schema.Array(Anchor),
});

export const ProjectCodecs = {
  liveChanges: exitCodec(Schema.Array(LiveChangeView), Schema.Never),
  liveAnchors: exitCodec(Schema.Array(SubjectAnchorsView), Schema.Never),
  settings: exitCodec(ProjectSettings, ProjectNotFound),
  putSettings: exitCodec(ProjectSettings, Schema.Union([ProjectNotFound, IdempotencyConflict])),
  createProject: exitCodec(ProjectView, Schema.Union([IdempotencyConflict, RepoNotFound])),
};

/** The Project DO (`project:<id>`): settings and the subject registry. */
export interface ProjectRpc extends EventReceiverRpc {
  /** The project's live changes, from each one's declare until it ends, for preflight. */
  liveChanges(): Promise<ExitJson>;
  /** Where the project's live changes anchor their subjects in code, for Precheck's derivation. */
  liveAnchors(): Promise<ExitJson>;
  settings(): Promise<ExitJson>;
  putSettings(command: typeof PutSettingsCommand.Encoded): Promise<ExitJson>;
  createProject(command: typeof CreateProjectCommand.Encoded): Promise<ExitJson>;
}
