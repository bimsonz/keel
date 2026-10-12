import { ChangePrecheck } from "@keeltown/core/ports";
import { Effect, Layer, Schema } from "effect";
import {
  ChangeCodecs,
  decodeExit,
  EffectsDerivedCommand,
  type ExitCodec,
  PlanCompiledCommand,
  PrecheckRefusedCommand,
  PrecheckStartedCommand,
} from "../../../rpc/index.ts";

/** Sends one call and decodes its Exit envelope; a thrown call or an answer that does not decode dies. */
const call = <A, E>(codec: ExitCodec<A, E>, send: () => Promise<unknown>) =>
  Effect.promise(send).pipe(
    Effect.flatMap((answer) => Effect.suspend(() => decodeExit(codec, answer))),
  );

/**
 * ChangePrecheck over the Change DO's RPC (`change:<ULID>`): Precheck reaches
 * the Change DO only through the Change contract, never its storage.
 */
export function ChangePrecheckRpc(changes: Env["CHANGE"]): Layer.Layer<ChangePrecheck> {
  const change = (changeId: string) => changes.get(changes.idFromName(`change:${changeId}`));
  return Layer.succeed(
    ChangePrecheck,
    ChangePrecheck.of({
      workspace: (changeId) => call(ChangeCodecs.workspace, () => change(changeId).workspace()),
      started: (changeId, step) =>
        call(ChangeCodecs.precheckStarted, () =>
          change(changeId).precheckStarted(
            Schema.encodeSync(PrecheckStartedCommand)({
              revision: step.revision,
              instanceId: step.instanceId,
            }),
          ),
        ).pipe(Effect.asVoid),
      derived: (changeId, derived) =>
        call(ChangeCodecs.effectsDerived, () =>
          change(changeId).effectsDerived(
            Schema.encodeSync(EffectsDerivedCommand)({
              revision: derived.revision,
              instanceId: derived.instanceId,
              effects: derived.effects,
              derivationRef: derived.derivationRef,
            }),
          ),
        ).pipe(Effect.asVoid),
      refused: (changeId, refusal) =>
        call(ChangeCodecs.precheckRefused, () =>
          change(changeId).precheckRefused(
            Schema.encodeSync(PrecheckRefusedCommand)({
              revision: refusal.revision,
              instanceId: refusal.instanceId,
              reasons: refusal.reasons,
              nextActions: refusal.nextActions,
            }),
          ),
        ).pipe(Effect.map((answer) => answer.verdictId)),
      compiled: (changeId, plan) =>
        call(ChangeCodecs.planCompiled, () =>
          change(changeId).planCompiled(
            Schema.encodeSync(PlanCompiledCommand)({
              revision: plan.revision,
              instanceId: plan.instanceId,
              planHash: plan.planHash,
              steps: plan.steps,
              costEstimate: plan.costEstimate,
              ...(plan.predicatePolicy === undefined
                ? {}
                : { predicatePolicy: plan.predicatePolicy }),
            }),
          ),
        ).pipe(Effect.asVoid),
    }),
  );
}
