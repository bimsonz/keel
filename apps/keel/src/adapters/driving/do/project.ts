import { createProject } from "@keeltown/core/application/integration";
import { ProjectId } from "@keeltown/core/kernel";
import { Effect, Schema } from "effect";
import {
  DEFAULT_POOL_TARGET,
  type ProjectServices,
  projectServices,
} from "../../../composition/do.ts";
import { CreateProjectCommand, ProjectCodecs, type ProjectRpc } from "../../../rpc/index.ts";
import { KeelObjectWith } from "./keel-object.ts";

/** The Project DO is named `project:<projectId>`. */
const projectIdOf = (name: string | undefined) =>
  Schema.decodeUnknownSync(ProjectId)(name?.replace(/^project:/, ""));

/**
 * The Project DO (`project:<id>`): the project, its settings and the subject
 * registry. Keel builds its RPC methods here, against the contract in src/rpc.
 */
export class ProjectDO
  extends KeelObjectWith<ProjectServices>
  implements Pick<ProjectRpc, "createProject">
{
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, projectServices(env));
  }

  /** Bootstraps the project: its repos, trunk and pool, then ProjectCreated. Idempotent by the operator's key. */
  async createProject(command: typeof CreateProjectCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(CreateProjectCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((creating) =>
        creating.projectId === projectId
          ? createProject(creating, DEFAULT_POOL_TARGET)
          : Effect.die(`a createProject for ${creating.projectId} reached ${projectId}`),
      ),
    );
    return this.answer(ProjectCodecs.createProject, program);
  }
}
