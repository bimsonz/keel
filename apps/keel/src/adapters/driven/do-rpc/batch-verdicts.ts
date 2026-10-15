import { BatchVerdicts } from "@keeltown/core/ports";
import { Effect, Exit, Layer, Schema } from "effect";
import { decodeExit, LaneCodecs, type LaneRpc, RecordVerdictCommand } from "../../../rpc/index.ts";

/** The lane DOs, addressed by name (`lane:<project>:<id>`). */
export interface LaneNamespace {
  get(id: DurableObjectId): Pick<LaneRpc, "recordVerdict">;
  idFromName(name: string): DurableObjectId;
}

/** A Durable Object namespace by shape: what `BatchVerdictsRpc` needs of `LANE`. */
export const isLaneNamespace = (value: unknown): value is LaneNamespace =>
  typeof value === "object" && value !== null && "get" in value && "idFromName" in value;

/** `BatchVerdicts` over the Lane DO's `recordVerdict`, decoding its Exit envelope back into tagged errors. */
export const BatchVerdictsRpc = (lanes: LaneNamespace) =>
  Layer.succeed(
    BatchVerdicts,
    BatchVerdicts.of({
      record: (laneId, verdict) =>
        Effect.promise(() =>
          lanes.get(lanes.idFromName(laneId)).recordVerdict(
            Schema.encodeSync(RecordVerdictCommand)({
              instanceId: verdict.instanceId,
              fence: verdict.fence,
              candidateId: verdict.candidateId,
              verdictId: verdict.verdictId,
              outcome: verdict.outcome,
              planHash: verdict.planHash,
              evidence: verdict.evidence,
              failingTests: verdict.failingTests,
              ...(verdict.nextActions === undefined ? {} : { nextActions: verdict.nextActions }),
              ...(verdict.unrun === true ? { unrun: true } : {}),
            }),
          ),
        ).pipe(
          Effect.flatMap((answer) => {
            const exit = decodeExit(LaneCodecs.recordVerdict, answer);
            return Exit.isSuccess(exit) ? Effect.void : Effect.failCause(exit.cause);
          }),
        ),
    }),
  );
