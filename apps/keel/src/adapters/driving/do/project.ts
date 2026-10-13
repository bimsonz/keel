import { hearLiveChange, liveAnchors, liveChanges } from "@keeltown/core/application/coordination";
import {
  acceptProjectInvitation,
  endProjectInvitation,
  inviteToProject,
} from "@keeltown/core/application/identity";
import {
  commitDeployTarget,
  commitDeployTargetClear,
  deployTargetsOf,
} from "@keeltown/core/application/delivery";
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
  AcceptProjectInvitationCommand,
  ClearDeployTargetCommand,
  CreateProjectCommand,
  EndProjectInvitationCommand,
  InviteToProjectCommand,
  ProjectCodecs,
  type ProjectRpc,
  PutSettingsCommand,
  SetDeployTargetCommand,
} from "../../../rpc/index.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** The Project DO is named `project:<projectId>`. */
const projectIdOf = (name: string | undefined) =>
  Schema.decodeUnknownSync(ProjectId)(name?.replace(/^project:/, ""));

/**
 * The Project DO (`project:<id>`): the project, its settings and the subject
 * registry. It holds the agents invited to it alone, one row an agent, and
 * writes the row the request gate reads after each move. Its RPC methods are
 * methods here, against the contract in src/rpc.
 */
export class ProjectDO
  extends KeelObjectWith<ProjectServices>
  implements
    Pick<
      ProjectRpc,
      | "createProject"
      | "settings"
      | "putSettings"
      | "deployTargets"
      | "setDeployTarget"
      | "clearDeployTarget"
      | "liveChanges"
      | "liveAnchors"
      | "inviteAgent"
      | "acceptInvitation"
      | "endInvitation"
    >
{
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, projectServices(env));
  }

  async inviteAgent(command: typeof InviteToProjectCommand.Encoded) {
    // The address says which project the invitation is to; no caller picks one.
    const projectId = projectIdOf(this.ctx.id.name);
    return this.answer(
      ProjectCodecs.inviteAgent,
      Schema.decodeUnknownEffect(InviteToProjectCommand)(command).pipe(
        Effect.orDie,
        Effect.flatMap(({ namespace, ...inviting }) =>
          inviteToProject({ namespace, projectId }, inviting),
        ),
      ),
    );
  }

  async acceptInvitation(command: typeof AcceptProjectInvitationCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    return this.answer(
      ProjectCodecs.acceptInvitation,
      Schema.decodeUnknownEffect(AcceptProjectInvitationCommand)(command).pipe(
        Effect.orDie,
        Effect.flatMap(({ namespace, ...accepting }) =>
          acceptProjectInvitation({ namespace, projectId }, accepting),
        ),
      ),
    );
  }

  async endInvitation(command: typeof EndProjectInvitationCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    return this.answer(
      ProjectCodecs.endInvitation,
      Schema.decodeUnknownEffect(EndProjectInvitationCommand)(command).pipe(
        Effect.orDie,
        Effect.flatMap(({ namespace, ...ending }) =>
          endProjectInvitation({ namespace, projectId }, ending),
        ),
      ),
    );
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

  /** Where the project's live changes anchor their subjects, read by each Precheck's derivation. */
  async liveAnchors() {
    return this.answer(
      ProjectCodecs.liveAnchors,
      EntityStore.use((store) => Effect.succeed(liveAnchors(store))),
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

  /** The project's deploy targets, in name order; ProjectNotFound before createProject. */
  async deployTargets() {
    return this.answer(ProjectCodecs.deployTargets, deployTargetsOf(projectIdOf(this.ctx.id.name)));
  }

  /** Sets one of the project's deploy targets, decided over the targets it holds. */
  async setDeployTarget(command: typeof SetDeployTargetCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(SetDeployTargetCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((setting) =>
        setting.projectId === projectId
          ? commitDeployTarget(setting)
          : Effect.die(`a setDeployTarget for ${setting.projectId} reached ${projectId}`),
      ),
    );
    return this.answer(ProjectCodecs.setDeployTarget, program);
  }

  /** Clears one of the project's deploy targets; refused when it holds none of that name. */
  async clearDeployTarget(command: typeof ClearDeployTargetCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(ClearDeployTargetCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((clearing) =>
        clearing.projectId === projectId
          ? commitDeployTargetClear(clearing)
          : Effect.die(`a clearDeployTarget for ${clearing.projectId} reached ${projectId}`),
      ),
    );
    return this.answer(ProjectCodecs.clearDeployTarget, program);
  }
}
