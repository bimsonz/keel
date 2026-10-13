import { TrunkOrigin } from "@keeltown/core/domain/integration";
import { ImportTooLarge, Trunks } from "@keeltown/core/ports";
import { Effect, Layer, Option, Schema } from "effect";
import { TrunkCodecs } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

const encodeOrigin = Schema.encodeSync(TrunkOrigin);

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
      initialize: (projectId, head, by, origin) =>
        callObject(TrunkCodecs.initialize, () =>
          trunk(projectId).initialize(head, by, encodeOrigin(origin)),
        ).pipe(
          Effect.asVoid,
          Effect.catchTag("ImportTooLarge", (large) => Effect.fail(new ImportTooLarge(large))),
        ),
      origin: (projectId) =>
        callObject(TrunkCodecs.status, () => trunk(projectId).status()).pipe(
          Effect.map((status) => Option.fromUndefinedOr(status.origin)),
          Effect.orDie,
        ),
      adopt: (projectId, commit) =>
        callObject(TrunkCodecs.adopt, () => trunk(projectId).adopt(commit)),
      seed: (projectId, name, at) =>
        callObject(TrunkCodecs.seed, () => trunk(projectId).seed(name, at)),
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
      destroy: (projectId, by) =>
        callObject(TrunkCodecs.destroy, () => trunk(projectId).destroy(by)),
    }),
  );
}
