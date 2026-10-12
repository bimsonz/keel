import { namespaceAddress } from "@keeltown/core/application/coordination";
import { HumanGate } from "@keeltown/core/ports";
import { Layer, Schema } from "effect";
import { NamespaceCodecs, RaiseCommand } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The namespace object's method `HumanGate` calls (`ns:<id>`), answering an Exit envelope. */
export interface HumanGateStub {
  raise(command: typeof RaiseCommand.Encoded): Promise<unknown>;
}

/** `HumanGate` over each namespace's object, addressed by name: the request's namespace picks the object and never crosses. */
export function HumanGateRpc(
  namespace: (address: string) => HumanGateStub,
): Layer.Layer<HumanGate> {
  return Layer.succeed(
    HumanGate,
    HumanGate.of({
      raise: ({ namespace: id, ...request }) =>
        callObject(NamespaceCodecs.raise, () =>
          namespace(namespaceAddress(id)).raise(Schema.encodeSync(RaiseCommand)(request)),
        ),
    }),
  );
}
