import { WorkspacePool } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { decodeExit, type ExitCodec, WorkspacePoolCodecs } from "../../../rpc/index.ts";

/** Sends one call and decodes its Exit envelope; a thrown call or an answer that does not decode dies. */
const call = <A, E>(codec: ExitCodec<A, E>, send: () => Promise<unknown>) =>
  Effect.promise(send).pipe(
    Effect.flatMap((answer) => Effect.suspend(() => decodeExit(codec, answer))),
  );

/**
 * The WorkspacePool port over the WorkspacePool DO's RPC. Each project's pool
 * is the object `pool:<projectId>`, placed by `locationHint` next to the
 * deployment's Artifacts namespaces, because it forks and deletes repos there.
 * A hint only places an object when it is first created; without one the
 * object is placed near its first caller.
 */
export function WorkspacePoolRpc(
  pools: Env["WORKSPACE_POOL"],
  locationHint?: DurableObjectLocationHint,
): Layer.Layer<WorkspacePool> {
  const pool = (projectId: string) =>
    pools.get(
      pools.idFromName(`pool:${projectId}`),
      locationHint === undefined ? undefined : { locationHint },
    );

  return Layer.succeed(
    WorkspacePool,
    WorkspacePool.of({
      grant: (projectId, holder) =>
        call(WorkspacePoolCodecs.grant, () => pool(projectId).grant(holder)),
      release: (projectId, workspaceId, reason) =>
        call(WorkspacePoolCodecs.release, () => pool(projectId).release(workspaceId, reason)).pipe(
          Effect.orDie,
        ),
      configure: (projectId, config) =>
        call(WorkspacePoolCodecs.configure, () => pool(projectId).configure(config)).pipe(
          Effect.asVoid,
        ),
      observePush: (projectId, pushId, push) =>
        call(WorkspacePoolCodecs.observePush, () => pool(projectId).observePush(pushId, push)),
      destroy: (projectId) =>
        call(WorkspacePoolCodecs.destroy, () => pool(projectId).destroy()).pipe(Effect.asVoid),
    }),
  );
}
