import {
  escalationRecord,
  giveRuling,
  namespaceAt,
  raiseEscalation,
  wideningsOwed,
  widenEscalation,
} from "@keeltown/core/application/coordination";
import { acceptInvitation, endInvitation, inviteAgent } from "@keeltown/core/application/identity";
import { EscalationId } from "@keeltown/core/kernel";
import { Effect, Schema } from "effect";
import { type NamespaceServices, namespaceServices } from "../../../composition/do.ts";
import {
  AcceptInvitationCommand,
  EndInvitationCommand,
  InviteAgentCommand,
  NamespaceCodecs,
  type NamespaceRpc,
  RaiseCommand,
  RuleCommand,
} from "../../../rpc/index.ts";
import { armedAlarms, cancelAlarm, scheduleAlarm, type StartedAlarm } from "./alarm.ts";
import { KeelObjectWith } from "./keel-object.ts";

const decoded = <S extends Schema.Top>(schema: S, input: unknown) =>
  Effect.orDie(Schema.decodeUnknownEffect(schema)(input));

/** The deadline at which an escalation's maintainers are asked too, by its reason. */
const WIDENS = /^escalation (esc_[0-9A-Z]+) widens$/;
const wideningDeadline = (escalationId: EscalationId) => `escalation ${escalationId} widens`;

/**
 * A namespace's object (`ns:<id>`): what belongs to whoever owns a project,
 * be it a person, an agent or an org. It hosts the escalations of the
 * namespace's projects through the domain's escalation machine, and records
 * the decision each ruling makes in the ruling's own transaction. Each event
 * carries the project its question is about, so the feed serves it there. It
 * holds the agents its members invited into it, one row an agent, and writes
 * the row the request gate reads after each move. It extends KeelObjectWith,
 * which builds its runtime and the event backbone.
 */
export class NamespaceDO extends KeelObjectWith<NamespaceServices> implements NamespaceRpc {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, namespaceServices(env));
  }

  async inviteAgent(command: typeof InviteAgentCommand.Encoded) {
    // The address says whose invitation it is; no caller picks a namespace.
    const namespace = namespaceAt(this.ctx.id.name);
    return this.answer(
      NamespaceCodecs.inviteAgent,
      decoded(InviteAgentCommand, command).pipe(
        Effect.flatMap((inviting) => inviteAgent(namespace, inviting)),
      ),
    );
  }

  async acceptInvitation(command: typeof AcceptInvitationCommand.Encoded) {
    const namespace = namespaceAt(this.ctx.id.name);
    return this.answer(
      NamespaceCodecs.acceptInvitation,
      decoded(AcceptInvitationCommand, command).pipe(
        Effect.flatMap((accepting) => acceptInvitation(namespace, accepting)),
      ),
    );
  }

  async endInvitation(command: typeof EndInvitationCommand.Encoded) {
    const namespace = namespaceAt(this.ctx.id.name);
    return this.answer(
      NamespaceCodecs.endInvitation,
      decoded(EndInvitationCommand, command).pipe(
        Effect.flatMap((ending) => endInvitation(namespace, ending)),
      ),
    );
  }

  async raise(command: typeof RaiseCommand.Encoded) {
    // The address says whose escalation it is; no caller picks a namespace.
    const namespace = namespaceAt(this.ctx.id.name);
    const answer = await this.answer(
      NamespaceCodecs.raise,
      decoded(RaiseCommand, command).pipe(
        Effect.flatMap((request) => raiseEscalation({ ...request, namespace })),
      ),
    );
    await this.armWidenings();
    return answer;
  }

  async rule(command: typeof RuleCommand.Encoded) {
    const answer = await this.answer(
      NamespaceCodecs.rule,
      decoded(RuleCommand, command).pipe(Effect.flatMap(giveRuling)),
    );
    await this.armWidenings();
    return answer;
  }

  async escalation(escalationId: string) {
    return this.answer(
      NamespaceCodecs.escalation,
      decoded(EscalationId, escalationId).pipe(Effect.flatMap(escalationRecord)),
    );
  }

  /** An escalation's thirty minutes are up: its maintainers are asked too, if it is still open. */
  protected override async onDeadline(request: StartedAlarm): Promise<void> {
    const escalationId = WIDENS.exec(request.reason)?.[1];
    if (escalationId === undefined) return super.onDeadline(request);
    await this.runtime.runPromise(
      decoded(EscalationId, escalationId).pipe(Effect.flatMap(widenEscalation)),
    );
    await this.armWidenings();
  }

  /**
   * Keeps the object's deadlines level with the widenings it owes: one for
   * each open escalation still with the person asked first, and none for any
   * other. What is owed is written with the escalation, so a deadline lost
   * between a commit and its arming is armed again by the next call.
   */
  private async armWidenings(): Promise<void> {
    const owed = await this.runtime.runPromise(wideningsOwed);
    const keep = new Set(owed.map((widening) => wideningDeadline(widening.escalationId)));
    for (const armed of armedAlarms(this.ctx.storage)) {
      if (WIDENS.test(armed.reason) && !keep.has(armed.reason))
        await cancelAlarm(this.ctx.storage, armed.reason);
    }
    for (const widening of owed)
      await scheduleAlarm(this.ctx.storage, {
        kind: "deadline",
        reason: wideningDeadline(widening.escalationId),
        at: widening.at,
      });
  }
}
