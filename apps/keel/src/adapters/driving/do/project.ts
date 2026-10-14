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
import {
  changeSettings,
  createProject,
  finishFailed,
  finishProject,
  holdPool,
  settingsOf,
} from "@keeltown/core/application/integration";
import { type EventEnvelope, Instant, ProjectId } from "@keeltown/core/kernel";
import { EntityStore, type Transaction } from "@keeltown/core/ports";
import { Cause, Effect, Exit, Schema } from "effect";
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
import { scheduleAlarm, type StartedAlarm } from "./alarm.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** The project's own deadline: what it needs beyond its trunk, made after it is answered. */
export const PROJECT_FINISH = "project finish";

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

  /**
   * Creates the project and answers once its trunk is initialized, then
   * makes the rest (staging, the mirror, the pool) on its own deadline.
   * Idempotent by the operator's key; a replay arms the finish again, which
   * makes only what is left, and nothing for a project that was not created.
   */
  async createProject(command: typeof CreateProjectCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(CreateProjectCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((creating) =>
        creating.projectId === projectId
          ? createProject(creating)
          : Effect.die(`a createProject for ${creating.projectId} reached ${projectId}`),
      ),
    );
    const answer = await this.answer(ProjectCodecs.createProject, program);
    await scheduleAlarm(this.ctx.storage, {
      kind: "deadline",
      reason: PROJECT_FINISH,
      at: Date.now(),
    });
    return answer;
  }

  protected override async onDeadline(request: StartedAlarm): Promise<void> {
    if (request.reason !== PROJECT_FINISH) return super.onDeadline(request);
    const projectId = projectIdOf(this.ctx.id.name);
    const exit = await this.runtime.runPromiseExit(finishProject(projectId, DEFAULT_POOL_TARGET));
    if (Exit.isSuccess(exit)) return;
    const failing = await this.runtime.runPromise(finishFailed(projectId));
    if (failing === undefined) return;
    const at = Date.now() + failing.delayMs;
    const why = Cause.pretty(exit.cause);
    const line = `project ${projectId}: finish step ${failing.step} failed ${failing.times}x, next in ${failing.delayMs} ms: ${why}`;
    if (failing.defect) console.error(`DEFECT ${line} (a finish step should not keep failing)`);
    else console.warn(line);
    // A grant while no workspace can exist is told to come back no sooner than the next try.
    const told = await this.runtime.runPromiseExit(holdPool(projectId, Instant(at)));
    if (Exit.isFailure(told))
      console.warn(
        `project ${projectId}: the pool was not told the finish's next try: ${Cause.pretty(told.cause)}`,
      );
    await scheduleAlarm(this.ctx.storage, { kind: "deadline", reason: PROJECT_FINISH, at });
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
