import { TrunkOrigin } from "@keeltown/core/domain/integration";
import { ImportTooLarge, RepoNotFound, Trunks, UpstreamUnreachable } from "@keeltown/core/ports";
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
        callObject(TrunkCodecs.origin, () => trunk(projectId).origin()).pipe(
          Effect.map((start) => Option.fromUndefinedOr(start.origin)),
          Effect.orDie,
        ),
      adopt: (projectId, commit) =>
        callObject(TrunkCodecs.adopt, () => trunk(projectId).adopt(commit)),
      seed: (projectId, name, at) =>
        callObject(TrunkCodecs.seed, () => trunk(projectId).seed(name, at)),
      take: (projectId, source) =>
        callObject(TrunkCodecs.take, () => trunk(projectId).take(source)).pipe(
          // The RPC carries both by shape (rule R15); the port's are its classes.
          Effect.catchTags({
            RepoNotFound: (missing) => Effect.fail(new RepoNotFound({ repo: missing.repo })),
            ImportTooLarge: (large) => Effect.fail(new ImportTooLarge(large)),
          }),
        ),
      head: (projectId) =>
        callObject(TrunkCodecs.status, () => trunk(projectId).status()).pipe(
          Effect.map((status) => status.head),
          Effect.orDie,
        ),
      view: (projectId) =>
        callObject(TrunkCodecs.view, () => trunk(projectId).view()).pipe(
          Effect.map((answer) => Option.fromUndefinedOr(answer.trunk)),
          Effect.orDie,
        ),
      sync: (projectId) =>
        callObject(TrunkCodecs.sync, () => trunk(projectId).sync()).pipe(
          Effect.map(({ head }) => ({ head, staging: head, mirror: head })),
          Effect.orDie,
        ),
      syncUpstream: (projectId, by) =>
        callObject(TrunkCodecs.syncUpstream, () => trunk(projectId).syncUpstream(by)).pipe(
          // The RPC carries the port's two by shape (rule R15).
          Effect.catchTags({
            UpstreamUnreachable: (unreachable) => Effect.fail(new UpstreamUnreachable(unreachable)),
            ImportTooLarge: (large) => Effect.fail(new ImportTooLarge(large)),
          }),
        ),
      cancel: (projectId, cancel) =>
        callObject(TrunkCodecs.cancel, () =>
          trunk(projectId).cancel({ ...cancel, members: [...cancel.members] }),
        ),
      destroy: (projectId, by) =>
        callObject(TrunkCodecs.destroy, () => trunk(projectId).destroy(by)),
    }),
  );
}
