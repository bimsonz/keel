import { makeId, type ProjectId } from "@keeltown/core/kernel";
import { Projects, RepoNotFound } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import { CreateProjectCommand, ProjectCodecs, PutSettingsCommand } from "../../../rpc/index.ts";
import { callObject, derivedUlid, fingerprintOf } from "./answer.ts";

/** The Project DO methods Keel calls (`project:<id>`), each answering an Exit envelope. */
export interface ProjectStub {
  createProject(command: typeof CreateProjectCommand.Encoded): Promise<unknown>;
  settings(): Promise<unknown>;
  putSettings(command: typeof PutSettingsCommand.Encoded): Promise<unknown>;
}

const encodeCreate = Schema.encodeSync(CreateProjectCommand);
const encodePut = Schema.encodeSync(PutSettingsCommand);

/**
 * `Projects` over Durable Object RPC. The project id is derived from the
 * operator and the Idempotency-Key, so a retry reaches the same Project DO,
 * which replays by key and refuses another body by fingerprint. A missing
 * source crosses as RepoNotFound by shape and is rebuilt as the port's error.
 * `settings` answers the project's settings, or ProjectNotFound; `putSettings`
 * replaces them as the principal, whose id the Project DO audits.
 */
export function ProjectsRpc(project: (projectId: ProjectId) => ProjectStub): Layer.Layer<Projects> {
  return Layer.succeed(
    Projects,
    Projects.of({
      create: (principal, input) =>
        Effect.gen(function* () {
          const projectId = makeId(
            "prj",
            yield* Effect.promise(() => derivedUlid(principal.agentId, input.idempotencyKey)),
          );
          const fingerprint = yield* Effect.promise(() =>
            fingerprintOf({ name: input.name, source: input.source }),
          );
          const command = encodeCreate({
            projectId,
            name: input.name,
            source: input.source,
            by: principal.agentId,
            idempotencyKey: input.idempotencyKey,
            fingerprint,
          });
          return yield* callObject(ProjectCodecs.createProject, () =>
            project(projectId).createProject(command),
          ).pipe(
            Effect.catchTag("RepoNotFound", (missing) =>
              Effect.fail(new RepoNotFound({ repo: missing.repo })),
            ),
          );
        }),
      settings: (projectId) =>
        callObject(ProjectCodecs.settings, () => project(projectId).settings()),
      putSettings: (principal, projectId, settings, requestId) =>
        callObject(ProjectCodecs.putSettings, () =>
          project(projectId).putSettings(
            encodePut({ projectId, settings, by: principal.agentId, requestId }),
          ),
        ),
    }),
  );
}
