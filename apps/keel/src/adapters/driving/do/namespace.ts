import {
  escalationRecord,
  giveRuling,
  namespaceAt,
  raiseEscalation,
} from "@keeltown/core/application/coordination";
import { EscalationId } from "@keeltown/core/kernel";
import { Effect, Schema } from "effect";
import {
  NamespaceCodecs,
  type NamespaceRpc,
  RaiseCommand,
  RuleCommand,
} from "../../../rpc/index.ts";
import { KeelObject } from "./keel-object.ts";

const decoded = <S extends Schema.Top>(schema: S, input: unknown) =>
  Effect.orDie(Schema.decodeUnknownEffect(schema)(input));

/**
 * A namespace's object (`ns:<id>`): what belongs to whoever owns a project,
 * be it a person, an agent or an org. It hosts the escalations of the
 * namespace's projects through the domain's escalation machine, and records
 * the decision each ruling makes in the ruling's own transaction. Each event
 * carries the project its question is about, so the feed serves it there. It
 * extends KeelObject, which builds its runtime and the event backbone.
 */
export class NamespaceDO extends KeelObject implements NamespaceRpc {
  async raise(command: typeof RaiseCommand.Encoded) {
    // The address says whose escalation it is; no caller picks a namespace.
    const namespace = namespaceAt(this.ctx.id.name);
    return this.answer(
      NamespaceCodecs.raise,
      decoded(RaiseCommand, command).pipe(
        Effect.flatMap((request) => raiseEscalation({ ...request, namespace })),
      ),
    );
  }

  async rule(command: typeof RuleCommand.Encoded) {
    return this.answer(
      NamespaceCodecs.rule,
      decoded(RuleCommand, command).pipe(Effect.flatMap(giveRuling)),
    );
  }

  async escalation(escalationId: string) {
    return this.answer(
      NamespaceCodecs.escalation,
      decoded(EscalationId, escalationId).pipe(Effect.flatMap(escalationRecord)),
    );
  }
}
