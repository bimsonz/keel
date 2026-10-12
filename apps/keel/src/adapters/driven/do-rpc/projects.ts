import { actorId } from "@keeltown/core/domain/identity";
import type { ProjectId } from "@keeltown/core/kernel";
import { Projects, RepoNotFound } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import { CreateProjectCommand, ProjectCodecs, PutSettingsCommand } from "../../../rpc/index.ts";
import { callObject, fingerprintOf } from "./answer.ts";

/** The Project DO methods Keel calls (`project:<id>`), each answering an Exit envelope. */
export interface ProjectStub {
  createProject(command: typeof CreateProjectCommand.Encoded): Promise<unknown>;
  settings(): Promise<unknown>;
  putSettings(command: typeof PutSettingsCommand.Encoded): Promise<unknown>;
  liveAnchors(): Promise<unknown>;
}

const encodeCreate = Schema.encodeSync(CreateProjectCommand);
const encodePut = Schema.encodeSync(PutSettingsCommand);

/**
 * `Projects` over Durable Object RPC. The project's DO is the one its id
 * names, which the caller derived from the actor and the Idempotency-Key, so a
 * retry reaches the same DO, which replays by key and refuses another body by
 * fingerprint. A missing source crosses as RepoNotFound by shape and is
 * rebuilt as the port's error. `settings` answers the project's settings, or
 * ProjectNotFound; `putSettings` replaces them as the actor, whose id the
 * Project DO audits.
 * `liveAnchors` reads the Project DO's live index; a project never created
 * has none.
 */
export function ProjectsRpc(project: (projectId: ProjectId) => ProjectStub): Layer.Layer<Projects> {
  return Layer.succeed(
    Projects,
    Projects.of({
      create: (actor, input) =>
        Effect.gen(function* () {
          const fingerprint = yield* Effect.promise(() =>
            fingerprintOf({ name: input.name, source: input.source }),
          );
          const command = encodeCreate({
            projectId: input.projectId,
            name: input.name,
            source: input.source,
            by: actorId(actor),
            idempotencyKey: input.idempotencyKey,
            fingerprint,
          });
          return yield* callObject(ProjectCodecs.createProject, () =>
            project(input.projectId).createProject(command),
          ).pipe(
            Effect.catchTag("RepoNotFound", (missing) =>
              Effect.fail(new RepoNotFound({ repo: missing.repo })),
            ),
          );
        }),
      settings: (projectId) =>
        callObject(ProjectCodecs.settings, () => project(projectId).settings()),
      putSettings: (actor, projectId, settings, requestId) =>
        callObject(ProjectCodecs.putSettings, () =>
          project(projectId).putSettings(
            encodePut({ projectId, settings, by: actorId(actor), requestId }),
          ),
        ),
      liveAnchors: (projectId) =>
        callObject(ProjectCodecs.liveAnchors, () => project(projectId).liveAnchors()),
    }),
  );
}
