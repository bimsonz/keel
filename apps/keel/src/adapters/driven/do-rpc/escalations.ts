import { namespaceAddress } from "@keeltown/core/application/coordination";
import { Escalations } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import {
  type EscalationRead,
  EscalationsRead,
  NamespaceCodecs,
  ProjectorCodecs,
  RuleCommand,
} from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Projector DO methods the escalation reads call, each answering an Exit envelope. */
export interface EscalationViewsStub {
  escalations(request: typeof EscalationsRead.Encoded): Promise<unknown>;
  escalation(request: typeof EscalationRead.Encoded): Promise<unknown>;
}

/** The namespace object's method a ruling calls (`ns:<id>`). */
export interface RulingStub {
  rule(command: typeof RuleCommand.Encoded): Promise<unknown>;
}

/**
 * `Escalations` over two objects. The reads come from the Projector's fold of
 * the escalations' events. A ruling goes to the escalation's namespace
 * object, found through that fold: an escalation the Projector has not heard
 * raised is not yet there to rule on.
 */
export function EscalationsRpc(
  projector: () => EscalationViewsStub,
  namespace: (address: string) => RulingStub,
): Layer.Layer<Escalations> {
  const get: (typeof Escalations)["Service"]["get"] = (escalationId) =>
    callObject(ProjectorCodecs.escalation, () => projector().escalation({ escalationId }));
  return Layer.succeed(
    Escalations,
    Escalations.of({
      list: (read) =>
        callObject(ProjectorCodecs.escalations, () =>
          projector().escalations(Schema.encodeSync(EscalationsRead)(read)),
        ),
      get,
      rule: (command) =>
        Effect.flatMap(get(command.escalationId), (known) =>
          callObject(NamespaceCodecs.rule, () =>
            namespace(namespaceAddress(known.namespace)).rule(
              Schema.encodeSync(RuleCommand)(command),
            ),
          ).pipe(Effect.map((ruled) => ({ ...ruled, label: known.label }))),
        ),
    }),
  );
}
