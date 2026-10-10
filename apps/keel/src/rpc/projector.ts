import { Schema } from "effect";
import type { EventReceiverRpc } from "./events.ts";
import { exitCodec, type ExitJson } from "./exit.ts";

export const ProjectorCodecs = {
  nudge: exitCodec(Schema.Struct({ drained: Schema.Int }), Schema.Never),
};

/** The Projector DO: drains the operation log into read models when nudged, then sleeps. */
export interface ProjectorRpc extends EventReceiverRpc {
  nudge(): Promise<ExitJson>;
}
