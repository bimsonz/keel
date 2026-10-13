import { mainLane } from "@keeltown/core/application/integration";
import { Lanes } from "@keeltown/core/ports";
import { Layer } from "effect";
import { LaneCodecs, type LaneRpc } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/** The lane DOs, addressed by name (`lane:<project>:<id>`): what `LanesRpc` needs of `LANE`. */
export interface DestroyableLanes {
  get(
    id: DurableObjectId,
    options?: { readonly locationHint?: DurableObjectLocationHint },
  ): Pick<LaneRpc, "destroy" | "verificationEnded">;
  idFromName(name: string): DurableObjectId;
}

/**
 * The Lanes port over the Lane DO's RPC, placed by `locationHint` like every
 * repo-touching object. A project has one lane at L1, `lane:<projectId>:main`.
 */
export function LanesRpc(
  lanes: DestroyableLanes,
  locationHint?: DurableObjectLocationHint,
): Layer.Layer<Lanes> {
  const lane = (laneId: string) =>
    lanes.get(lanes.idFromName(laneId), locationHint === undefined ? undefined : { locationHint });
  return Layer.succeed(
    Lanes,
    Lanes.of({
      destroy: (projectId, by) =>
        callObject(LaneCodecs.destroy, () => lane(mainLane(projectId)).destroy(by)),
      verificationEnded: (laneId, instanceId) =>
        callObject(LaneCodecs.verificationEnded, () =>
          lane(laneId).verificationEnded({ instanceId }),
        ),
    }),
  );
}
