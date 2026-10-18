import {
  hearLiveChange,
  liveAnchors,
  liveGoalOf,
  liveNear,
} from "@keeltown/core/application/coordination";
import {
  acceptProjectInvitation,
  endProjectInvitation,
  inviteToProject,
} from "@keeltown/core/application/identity";
import {
  commitDeployTarget,
  commitDeployTargetClear,
  deploymentOf,
  deployTargetsOf,
  holdConnect,
  takeConnect,
  promoteDeployment,
  recordDeployment,
  refuseDelivery,
} from "@keeltown/core/application/delivery";
import {
  changeSettings,
  createProject,
  finishFailed,
  finishProject,
  holdPool,
  settingsOf,
} from "@keeltown/core/application/integration";
import {
  closeIssuesNamed,
  issuePage,
  issueThread,
  moveIssue,
  openIssue,
} from "@keeltown/core/application/issues";
import { ChangeId, type EventEnvelope, Instant, ProjectId } from "@keeltown/core/kernel";
import { EntityStore, type Transaction } from "@keeltown/core/ports";
import { Cause, Effect, Exit, Schema } from "effect";
import { poolTargetOf, type ProjectServices, projectServices } from "../../../composition/do.ts";
import {
  AcceptProjectInvitationCommand,
  ClearDeployTargetCommand,
  HoldConnectCommand,
  TakeConnectCommand,
  CreateProjectCommand,
  DeliveryRefusedCommand,
  DeploymentOfCommand,
  DeploymentPromotedCommand,
  EndProjectInvitationCommand,
  InviteToProjectCommand,
  IssueRead,
  IssuesRead,
  LiveNearRead,
  MoveIssueCommand,
  OpenIssueCommand,
  ProjectCodecs,
  type ProjectRpc,
  PutSettingsCommand,
  RecordDeploymentCommand,
  SetDeployTargetCommand,
} from "../../../rpc/index.ts";
import { scheduleAlarm, type StartedAlarm } from "./alarm.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** The project's own deadline: what it needs beyond its trunk, made after it is answered. */
export const PROJECT_FINISH = "project finish";

/** The issues a landed change's goal names, closed as completed in the landing's own transaction. */
const closedBy = (tx: Transaction, projectId: ProjectId, event: EventEnvelope) => {
  const changeId = Schema.decodeUnknownSync(ChangeId)(event.entity.id);
  const goal = liveGoalOf(tx.store, changeId);
  return goal === undefined ? [] : closeIssuesNamed(tx, projectId, changeId, goal);
};

/** The Project DO is named `project:<projectId>`. */
const projectIdOf = (name: string | undefined) =>
  Schema.decodeUnknownSync(ProjectId)(name?.replace(/^project:/, ""));

/**
 * The Project DO (`project:<id>`): the project, its settings and the subject
 * registry. It holds the agents invited to it alone, one row an agent, and
 * writes the row the request gate reads after each move. Its RPC methods are
 * built here, against the contract in src/rpc.
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
      | "holdConnect"
      | "takeConnect"
      | "recordDeployment"
      | "deploymentOf"
      | "deploymentPromoted"
      | "deliveryRefused"
      | "liveNear"
      | "liveAnchors"
      | "inviteAgent"
      | "acceptInvitation"
      | "endInvitation"
      | "openIssue"
      | "moveIssue"
      | "issues"
      | "issue"
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
    const exit = await this.runtime.runPromiseExit(
      finishProject(projectId, poolTargetOf(this.env.POOL_TARGET)),
    );
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
    // Read before the index forgets the change: a landing closes the issues its goal names.
    const closing = event.type === "ChangeLanded" ? closedBy(tx, projectId, event) : [];
    const drafts = [...hearLiveChange(tx, projectId, event), ...closing];
    return drafts.length === 0
      ? { drafts: [] }
      : { entity: { kind: "project", id: projectId }, drafts, project: projectId };
  }

  /** Opens an issue on the project with its next `#n`; a retry by the same key answers it again. */
  async openIssue(command: typeof OpenIssueCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    return this.answer(
      ProjectCodecs.openIssue,
      Schema.decodeUnknownEffect(OpenIssueCommand)(command).pipe(
        Effect.orDie,
        Effect.flatMap((opening) => openIssue(projectId, opening)),
      ),
    );
  }

  /** Comments on, closes or reopens issue `#n`; IssueNotFound for one the project has not got. */
  async moveIssue(command: typeof MoveIssueCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    return this.answer(
      ProjectCodecs.moveIssue,
      Schema.decodeUnknownEffect(MoveIssueCommand)(command).pipe(
        Effect.orDie,
        Effect.flatMap((moving) => moveIssue(projectId, moving)),
      ),
    );
  }

  /** A page of the project's issues, newest first. */
  async issues(read: typeof IssuesRead.Encoded) {
    return this.answer(
      ProjectCodecs.issues,
      Schema.decodeUnknownEffect(IssuesRead)(read).pipe(
        Effect.orDie,
        Effect.flatMap((query) => Effect.map(EntityStore, (store) => issuePage(store, query))),
      ),
    );
  }

  /** Issue `#n` and its comments; IssueNotFound for one the project has not got. */
  async issue(read: typeof IssueRead.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    return this.answer(
      ProjectCodecs.issue,
      Schema.decodeUnknownEffect(IssueRead)(read).pipe(
        Effect.orDie,
        Effect.flatMap(({ number }) =>
          Effect.flatMap(EntityStore, (store) =>
            Effect.fromResult(issueThread(store, projectId, number)),
          ),
        ),
      ),
    );
  }

  /**
   * The live changes near a change's intent, read once by each preflight: by
   * key, in a transaction, since an index from before the key rows builds
   * them on its first read.
   */
  async liveNear(read: typeof LiveNearRead.Encoded) {
    return this.answer(
      ProjectCodecs.liveNear,
      Schema.decodeUnknownEffect(LiveNearRead)(read).pipe(
        Effect.orDie,
        Effect.flatMap(({ self, intent }) =>
          EntityStore.use((store) =>
            Effect.sync(() => store.transaction(() => liveNear(store, self, intent))),
          ),
        ),
      ),
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

  /** Holds a Connect its owner begins on the project, lapsing by this object's clock. */
  async holdConnect(command: typeof HoldConnectCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(HoldConnectCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((holding) =>
        holding.projectId === projectId
          ? holdConnect(holding)
          : Effect.die(`a holdConnect for ${holding.projectId} reached ${projectId}`),
      ),
    );
    return this.answer(ProjectCodecs.holdConnect, program);
  }

  /** Takes the Connect its owner began, once: it is gone whatever the answer. */
  async takeConnect(command: typeof TakeConnectCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(TakeConnectCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((taking) =>
        taking.projectId === projectId
          ? takeConnect(taking)
          : Effect.die(`a takeConnect for ${taking.projectId} reached ${projectId}`),
      ),
    );
    return this.answer(ProjectCodecs.takeConnect, program);
  }

  /** Keeps a candidate's deployment, in place of any kept for it before; ProjectNotFound before createProject. */
  async recordDeployment(command: typeof RecordDeploymentCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(RecordDeploymentCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((recording) =>
        recording.projectId === projectId
          ? recordDeployment(projectId, recording.deployment)
          : Effect.die(`a recordDeployment for ${recording.projectId} reached ${projectId}`),
      ),
    );
    return this.answer(ProjectCodecs.recordDeployment, program);
  }

  /** The deployment the project keeps for a candidate, or undefined; ProjectNotFound before createProject. */
  async deploymentOf(command: typeof DeploymentOfCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(DeploymentOfCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap((reading) =>
        reading.projectId === projectId
          ? deploymentOf(projectId, reading.candidateId)
          : Effect.die(`a deploymentOf for ${reading.projectId} reached ${projectId}`),
      ),
    );
    return this.answer(ProjectCodecs.deploymentOf, program);
  }

  /** Marks one of the project's deployments promoted to trunk's commit, committing DeploymentPromoted once. */
  async deploymentPromoted(command: typeof DeploymentPromotedCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(DeploymentPromotedCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap(({ projectId: promotedIn, ...promotion }) =>
        promotedIn === projectId
          ? promoteDeployment(projectId, promotion)
          : Effect.die(`a deploymentPromoted for ${promotedIn} reached ${projectId}`),
      ),
    );
    return this.answer(ProjectCodecs.deploymentPromoted, program);
  }

  /** Commits DeliveryRefused: trunk advanced and Keel deployed nothing, once per trunk commit. */
  async deliveryRefused(command: typeof DeliveryRefusedCommand.Encoded) {
    const projectId = projectIdOf(this.ctx.id.name);
    const program = Schema.decodeUnknownEffect(DeliveryRefusedCommand)(command).pipe(
      Effect.orDie,
      Effect.flatMap(({ projectId: refusedIn, ...refusal }) =>
        refusedIn === projectId
          ? refuseDelivery(projectId, refusal)
          : Effect.die(`a deliveryRefused for ${refusedIn} reached ${projectId}`),
      ),
    );
    return this.answer(ProjectCodecs.deliveryRefused, program);
  }
}
