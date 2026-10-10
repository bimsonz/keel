import { Schema } from "effect";
import { exitCodec, type ExitJson } from "./exit.ts";

export const ProjectorCodecs = {
  nudge: exitCodec(Schema.Struct({ drained: Schema.Int }), Schema.Never),
};

/** The Projector DO: drains the operation log into read models when nudged, then sleeps. */
export interface ProjectorRpc {
  nudge(): Promise<ExitJson>;
}
