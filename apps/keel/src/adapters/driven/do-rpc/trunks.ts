import { Trunks } from "@keeltown/core/ports";
import { Effect, Layer } from "effect";
import { TrunkCodecs } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/**
 * The Trunks port over the Trunk DO's RPC (`trunk:<projectId>`), placed by
 * `locationHint` next to the deployment's Artifacts namespaces, because it
 * pushes to and relays from repos there. A sync that cannot finish (a repo
 * missing, a pack over the cap) dies: a bootstrap must fail loudly, never
 * leave a project whose staging or mirror lacks trunk.
 */
export function TrunksRpc(
  trunks: Env["TRUNK"],
  locationHint?: DurableObjectLocationHint,
): Layer.Layer<Trunks> {
  const trunk = (projectId: string) =>
    trunks.get(
      trunks.idFromName(`trunk:${projectId}`),
      locationHint === undefined ? undefined : { locationHint },
    );

  return Layer.succeed(
    Trunks,
    Trunks.of({
      initialize: (projectId, head, by) =>
        callObject(TrunkCodecs.initialize, () => trunk(projectId).initialize(head, by)).pipe(
          Effect.asVoid,
        ),
      head: (projectId) =>
        callObject(TrunkCodecs.status, () => trunk(projectId).status()).pipe(
          Effect.map((status) => status.head),
          Effect.orDie,
        ),
      sync: (projectId) =>
        callObject(TrunkCodecs.sync, () => trunk(projectId).sync()).pipe(
          Effect.map(({ head }) => ({ head, staging: head, mirror: head })),
          Effect.orDie,
        ),
    }),
  );
}
