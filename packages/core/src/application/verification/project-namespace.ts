import { Effect, Option, Schema } from "effect";
import { OrgId, ProjectId } from "../../domain/kernel/index.ts";
import { ProjectOrgs } from "../ports/index.ts";

/** The project has no place, so it belongs to no namespace: nothing of it can be stored or read. */
export class ProjectUnplaced extends Schema.TaggedError<ProjectUnplaced>()("ProjectUnplaced", {
  projectId: ProjectId,
}) {}

/** A job names one namespace and its project belongs to another: it would read and write the wrong namespace's objects. */
export class NamespaceMisnamed extends Schema.TaggedError<NamespaceMisnamed>()(
  "NamespaceMisnamed",
  { projectId: ProjectId, named: OrgId, namespace: OrgId },
) {}

/**
 * The namespace a project belongs to: the one every object Keel keeps for it
 * is stored under. A project with no place has none, and there is no
 * namespace to fall back on: whoever asks stops there.
 */
export const projectNamespace = Effect.fn("verification/projectNamespace")(function* (
  projectId: ProjectId,
) {
  const place = yield* (yield* ProjectOrgs).byId(projectId);
  if (Option.isNone(place)) return yield* new ProjectUnplaced({ projectId });
  return place.value.org;
});

/**
 * The namespace of a job that was started naming one (a Workflow's payload
 * fixes where its runners fetch their bundle before any step runs): the
 * project's own, read again, and refused when the job named another.
 */
export const jobNamespace = Effect.fn("verification/jobNamespace")(function* (
  projectId: ProjectId,
  named: OrgId,
) {
  const namespace = yield* projectNamespace(projectId);
  if (namespace !== named) return yield* new NamespaceMisnamed({ projectId, named, namespace });
  return namespace;
});

/** Why an instance has no namespace to run in, naming its project: the text its Workflow ends with. */
export const describeNoNamespace = (error: ProjectUnplaced | NamespaceMisnamed): string =>
  error._tag === "ProjectUnplaced"
    ? `project ${error.projectId} belongs to no namespace`
    : `project ${error.projectId} belongs to namespace ${error.namespace}, and its job names ${error.named}`;
