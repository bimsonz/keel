import { hearLiveChange, liveChanges } from "@keeltown/core/application/coordination";
import { changeSettings, createProject, settingsOf } from "@keeltown/core/application/integration";
import { type EventEnvelope, ProjectId } from "@keeltown/core/kernel";
import { EntityStore, type Transaction } from "@keeltown/core/ports";
import { Effect, Schema } from "effect";
import {
  DEFAULT_POOL_TARGET,
  type ProjectServices,
  projectServices,
} from "../../../composition/do.ts";
import {
  CreateProjectCommand,
  ProjectCodecs,
  type ProjectRpc,
  PutSettingsCommand,
} from "../../../rpc/index.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** The Project DO is named `project:<projectId>`. */
const projectIdOf = (name: string | undefined) =>
  Schema.decodeUnknownSync(ProjectId)(name?.replace(/^project:/, ""));

/**
 * The Project DO (`project:<id>`): the project, its settings and the subject
 * registry. Keel builds its RPC methods here, against the contract in src/rpc.
 */
export class ProjectDO
  extends KeelObjectWith<ProjectServices>
  implements Pick<ProjectRpc, "createProject" | "settings" | "putSettings" | "liveChanges">
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

  /**
   * The live-change index: each change of the project subscribes it, scoped,
   * at declare, and every event folds in the transaction that receives it. The
   * notices it gives (a change's alternatives) go on the project.
   */
  protected override react(event: EventEnvelope, tx: Transaction): Reaction | undefined {
    const projectId = projectIdOf(this.ctx.id.name);
    const drafts = hearLiveChange(tx, projectId, event);
    return drafts.length === 0
      ? { drafts: [] }
      : { entity: { kind: "project", id: projectId }, drafts, project: projectId };
  }

  /** The project's live changes, read once by each preflight. */
  async liveChanges() {
    return this.answer(
      ProjectCodecs.liveChanges,
      EntityStore.use((store) => Effect.succeed(liveChanges(store))),
    );
  }

  /** The project's settings: the defaults until an operator changes them; ProjectNotFound before createProject. */
  async settings() {
    return this.answer(ProjectCodecs.settings, settingsOf(projectIdOf(this.ctx.id.name)));
  }

  /** Replaces the project's settings, auditing every changed field. */
  async putSettings(command: typeof PutSettingsCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(PutSettingsCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((putting) =>
        putting.projectId === projectId
          ? changeSettings(putting)
          : Effect.die(`a putSettings for ${putting.projectId} reached ${projectId}`),
      ),
    );
    return this.answer(ProjectCodecs.putSettings, program);
  }
}
