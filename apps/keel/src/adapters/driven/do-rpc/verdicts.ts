import { Verdicts } from "@keeltown/core/ports";
import { Layer } from "effect";
import { ProjectorCodecs, type VerdictRead } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The Projector DO method the verdict read calls, answering an Exit envelope. */
export interface VerdictIndexStub {
  verdict(request: typeof VerdictRead.Encoded): Promise<unknown>;
}

/** `Verdicts` over the Projector's verdict index. */
export function VerdictsRpc(projector: () => VerdictIndexStub): Layer.Layer<Verdicts> {
  return Layer.succeed(
    Verdicts,
    Verdicts.of({
      get: (verdictId) =>
        callObject(ProjectorCodecs.verdict, () => projector().verdict({ verdictId })),
    }),
  );
}
