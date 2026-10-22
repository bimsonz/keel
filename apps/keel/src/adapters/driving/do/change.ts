import {
  abandon,
  adopt,
  approveProposal,
  awaitPlan,
  awaitSubmission,
  CHANGE_WORKSPACE,
  changeRead,
  changeWorkspace,
  closeProposal,
  declare,
  effectsDerived,
  getChange,
  HeldWorkspace,
  lapseLease,
  nearby,
  planCompiled,
  precheckRefused,
  precheckStarted,
  propose,
  reactToBatch,
  rebase,
  commitEdits,
  refreshWorkspace,
  rely,
  distinguish,
  requestProposalChanges,
  revise,
  submissionMoved,
  submissionStatus,
  submit,
  updateProposal,
} from "@keeltown/core/application/coordination";
import { tellPreview } from "@keeltown/core/application/delivery";
import { isAgentOwned, lapsesAt } from "@keeltown/core/domain/coordination";
import { ChangeId, type EventEnvelope, LeaseId } from "@keeltown/core/kernel";
import type { Transaction } from "@keeltown/core/ports";
import { Effect, Exit, Option, Schema } from "effect";
import {
  type ChangeServices,
  changeServices,
  type DurableObjectServices,
} from "../../../composition/do.ts";
import {
  AbandonCommand,
  AdoptCommand,
  ApproveProposalCommand,
  AwaitPlanCommand,
  AwaitSubmissionCommand,
  ChangeCodecs,
  type ChangeRpc,
  CloseProposalCommand,
  DeclareCommand,
  EffectsDerivedCommand,
  NearbyCommand,
  type ExitCodec,
  PlanCompiledCommand,
  PrecheckRefusedCommand,
  PrecheckStartedCommand,
  ProposeCommand,
  RebaseCommand,
  CommitCommand,
  RefreshCommand,
  RelyCommand,
  DistinguishCommand,
  RequestProposalChangesCommand,
  ReviseCommand,
  SubmitCommand,
  TellPreviewCommand,
  UpdateProposalCommand,
} from "../../../rpc/index.ts";
import { armedAlarms, cancelAlarm, scheduleAlarm, type StartedAlarm } from "./alarm.ts";
import { KeelObjectWith, type Reaction } from "./keel-object.ts";

/** The Change DO is named `change:<changeId>`. */
const changeIdOf = (name: string | undefined) =>
  Schema.decodeUnknownSync(ChangeId)(name?.replace(/^change:/, ""));

/** An RPC argument in its decoded form. One that does not decode is the caller's defect. */
const decoded = <S extends Schema.Top>(schema: S, input: unknown) =>
  Effect.orDie(Schema.decodeUnknownEffect(schema)(input));

/** A lease's deadline is its own alarm row, so adoption withdraws the old one and arms the new. */
const LEASE_DEADLINE = /^lease (\S+) lapses$/;
const leaseDeadline = (leaseId: string) => `lease ${leaseId} lapses`;

/**
 * The Change DO (`change:<ULID>`): a change and its lease, decided by the
 * domain's Change machine through the coordination use-cases. Every method
 * answers with an Exit envelope, and every answer leaves the lease's deadline
 * armed exactly while the lease is active.
 */
export class ChangeDO extends KeelObjectWith<ChangeServices> implements ChangeRpc {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, changeServices(env));
    // A crash between a commit and arming its deadline leaves the alarm unset; the next instance re-arms it from the state.
    void ctx.blockConcurrencyWhile(() => this.armLease());
  }

  private get changeId(): ChangeId {
    return changeIdOf(this.ctx.id.name);
  }

  /** Answers, then arms the lease's deadline for whatever the call left. */
  protected override async answer<A, E>(
    codec: ExitCodec<A, E>,
    program: Effect.Effect<A, E, DurableObjectServices | ChangeServices>,
  ) {
    const answered = await super.answer(codec, program);
    await this.armLease();
    return answered;
  }

  async get() {
    return this.answer(ChangeCodecs.get, changeRead(this.changeId));
  }

  async declare(command: typeof DeclareCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(DeclareCommand, command).pipe(
      Effect.flatMap((declaring) =>
        declaring.changeId === changeId
          ? declare(declaring)
          : Effect.die(`a declare for ${declaring.changeId} reached ${changeId}`),
      ),
    );
    return this.answer(ChangeCodecs.declare, program);
  }

  async revise(command: typeof ReviseCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(ReviseCommand, command).pipe(
      Effect.flatMap((revising) => revise(changeId, revising)),
    );
    return this.answer(ChangeCodecs.revise, program);
  }

  async distinguish(command: typeof DistinguishCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(DistinguishCommand, command).pipe(
      Effect.flatMap((distinguishing) => distinguish(changeId, distinguishing)),
    );
    return this.answer(ChangeCodecs.distinguish, program);
  }

  async rely(command: typeof RelyCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(RelyCommand, command).pipe(
      Effect.flatMap((relying) => rely(changeId, relying)),
    );
    return this.answer(ChangeCodecs.rely, program);
  }

  async nearby(command: typeof NearbyCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(NearbyCommand, command).pipe(
      Effect.flatMap((reading) => nearby(changeId, reading)),
    );
    return this.answer(ChangeCodecs.nearby, program);
  }

  async awaitSubmission(command: typeof AwaitSubmissionCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(AwaitSubmissionCommand, command).pipe(
      Effect.flatMap(({ subscriber }) => awaitSubmission(changeId, subscriber)),
    );
    return this.answer(ChangeCodecs.awaitSubmission, program);
  }

  async awaitPlan(command: typeof AwaitPlanCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(AwaitPlanCommand, command).pipe(
      Effect.flatMap(({ subscriber }) => awaitPlan(changeId, subscriber)),
    );
    return this.answer(ChangeCodecs.awaitPlan, program);
  }

  async submit(command: typeof SubmitCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(SubmitCommand, command).pipe(
      Effect.flatMap((submitting) => submit(changeId, submitting)),
    );
    return this.answer(ChangeCodecs.submit, program);
  }

  async rebase(command: typeof RebaseCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(RebaseCommand, command).pipe(
      Effect.flatMap((rebasing) => rebase(changeId, rebasing)),
    );
    return this.answer(ChangeCodecs.rebase, program);
  }

  async commit(command: typeof CommitCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(CommitCommand, command).pipe(
      Effect.flatMap((committing) => commitEdits(changeId, committing)),
    );
    return this.answer(ChangeCodecs.commit, program);
  }

  async refreshWorkspace(command: typeof RefreshCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(RefreshCommand, command).pipe(
      Effect.flatMap((refreshing) => refreshWorkspace(changeId, refreshing)),
    );
    return this.answer(ChangeCodecs.refreshWorkspace, program);
  }

  async abandon(command: typeof AbandonCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(AbandonCommand, command).pipe(
      Effect.flatMap((abandoning) => abandon(changeId, abandoning)),
    );
    return this.answer(ChangeCodecs.abandon, program);
  }

  async propose(command: typeof ProposeCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(ProposeCommand, command).pipe(
      Effect.flatMap((proposing) => propose(changeId, { ...proposing, changeId })),
    );
    return this.answer(ChangeCodecs.propose, program);
  }

  async updateProposal(command: typeof UpdateProposalCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(UpdateProposalCommand, command).pipe(
      Effect.flatMap((moving) => updateProposal(changeId, moving)),
    );
    return this.answer(ChangeCodecs.updateProposal, program);
  }

  async approveProposal(command: typeof ApproveProposalCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(ApproveProposalCommand, command).pipe(
      Effect.flatMap((approving) => approveProposal(changeId, approving)),
    );
    return this.answer(ChangeCodecs.approveProposal, program);
  }

  async requestProposalChanges(command: typeof RequestProposalChangesCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(RequestProposalChangesCommand, command).pipe(
      Effect.flatMap((asking) => requestProposalChanges(changeId, asking)),
    );
    return this.answer(ChangeCodecs.requestProposalChanges, program);
  }

  async closeProposal(command: typeof CloseProposalCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(CloseProposalCommand, command).pipe(
      Effect.flatMap((closing) => closeProposal(changeId, closing)),
    );
    return this.answer(ChangeCodecs.closeProposal, program);
  }

  async adopt(command: typeof AdoptCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(AdoptCommand, command).pipe(
      Effect.flatMap((adopting) => adopt(changeId, adopting)),
    );
    return this.answer(ChangeCodecs.adopt, program);
  }

  /** The change once its submission state moves, or as it stands at the deadline (0–30 s). */
  async submission(waitMs: number) {
    const changeId = this.changeId;
    const waiters = this.waiters;
    const program = Effect.gen(function* () {
      const before = yield* submissionStatus(changeId);
      return yield* waiters.until(waitMs, submissionStatus(changeId), (now) =>
        submissionMoved(before, now),
      );
    });
    return this.answer(ChangeCodecs.submission, program);
  }

  async workspace() {
    return this.answer(ChangeCodecs.workspace, changeWorkspace(this.changeId));
  }

  async precheckStarted(command: typeof PrecheckStartedCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(PrecheckStartedCommand, command).pipe(
      Effect.flatMap((step) => precheckStarted(changeId, step)),
    );
    return this.answer(ChangeCodecs.precheckStarted, program);
  }

  async effectsDerived(command: typeof EffectsDerivedCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(EffectsDerivedCommand, command).pipe(
      Effect.flatMap((derived) => effectsDerived(changeId, derived)),
    );
    return this.answer(ChangeCodecs.effectsDerived, program);
  }

  async precheckRefused(command: typeof PrecheckRefusedCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(PrecheckRefusedCommand, command).pipe(
      Effect.flatMap((refusal) => precheckRefused(changeId, refusal)),
    );
    return this.answer(ChangeCodecs.precheckRefused, program);
  }

  async planCompiled(command: typeof PlanCompiledCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(PlanCompiledCommand, command).pipe(
      Effect.flatMap((plan) => planCompiled(changeId, plan)),
    );
    return this.answer(ChangeCodecs.planCompiled, program);
  }

  /** KeelVerify's preview step tells the change where its candidate's preview answers; a change never made is told nothing. */
  async tellPreview(command: typeof TellPreviewCommand.Encoded) {
    const changeId = this.changeId;
    const program = decoded(TellPreviewCommand, command).pipe(
      Effect.flatMap(({ changeId: toldTo, ...notice }) =>
        toldTo === changeId
          ? tellPreview(changeId, notice)
          : Effect.die(`a tellPreview for ${toldTo} reached ${changeId}`),
      ),
    );
    return this.answer(ChangeCodecs.tellPreview, program);
  }

  /**
   * Its batch's events and trunk's move the change on (`reactToBatch`). The
   * change takes its workspace before it decides, so a WorkspaceGranted
   * delivered later changes nothing; one for another workspace is a defect
   * worth an alert, and still commits nothing.
   */
  protected override react(event: EventEnvelope, tx: Transaction): Reaction | undefined {
    if (event.type !== "WorkspaceGranted") {
      const reaction = reactToBatch(this.changeId, event, tx);
      if (reaction === undefined) return undefined;
      const { drafts, project, problem } = reaction;
      if (problem !== undefined)
        console.error(
          JSON.stringify({
            ops: "change-reaction",
            changeId: this.changeId,
            eventId: event.eventId,
            problem,
          }),
        );
      if (drafts.length === 0) return { drafts: [] };
      return {
        entity: { kind: "change", id: this.changeId },
        drafts,
        ...(project === undefined ? {} : { project }),
      };
    }
    const stored = tx.store.get(CHANGE_WORKSPACE, this.changeId);
    const held = stored === undefined ? undefined : Schema.decodeUnknownSync(HeldWorkspace)(stored);
    const { payload } = event;
    const granted =
      typeof payload === "object" && payload !== null && "workspaceId" in payload
        ? payload.workspaceId
        : undefined;
    if (held !== undefined && held.workspaceId !== granted)
      console.error(
        "change granted a second workspace",
        JSON.stringify({ changeId: this.changeId, held: held.workspaceId, granted }),
      );
    return undefined;
  }

  /** The lease's deadline: makes the lapse visible, then re-arms only while the lease is still active. */
  protected override async onDeadline(request: StartedAlarm): Promise<void> {
    const leaseId = LEASE_DEADLINE.exec(request.reason)?.[1];
    if (leaseId === undefined) return super.onDeadline(request);
    const exit = await this.runtime.runPromiseExit(
      lapseLease(
        this.changeId,
        Schema.decodeUnknownSync(LeaseId)(leaseId),
        `${request.reason}@${request.at}`,
      ),
    );
    if (Exit.isFailure(exit))
      console.warn("lease deadline refused", JSON.stringify({ reason: request.reason }));
    await this.armLease();
  }

  /**
   * Arms the active lease's deadline at `renewedAt` + 15 min while the change
   * waits on its agent, and withdraws every other deadline: a lease cannot
   * lapse while the platform holds the change.
   */
  private async armLease(): Promise<void> {
    const change = await this.runtime.runPromise(Effect.option(getChange(this.changeId)));
    const held =
      Option.isSome(change) && isAgentOwned(change.value.state) ? change.value : undefined;
    // A proposal has no lease: no agent holds it, so nothing lapses.
    const active = held?.lease?.state === "active" ? held.lease : undefined;
    const keep = active === undefined ? undefined : leaseDeadline(active.id);
    for (const armed of armedAlarms(this.ctx.storage)) {
      if (LEASE_DEADLINE.test(armed.reason) && armed.reason !== keep)
        await cancelAlarm(this.ctx.storage, armed.reason);
    }
    if (active !== undefined && keep !== undefined)
      await scheduleAlarm(this.ctx.storage, {
        kind: "deadline",
        reason: keep,
        at: lapsesAt(active),
      });
  }
}
