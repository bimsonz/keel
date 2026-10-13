import { usageAddress } from "@keeltown/core/application/identity";
import type { NamespaceId } from "@keeltown/core/kernel";
import { NamespaceUsage } from "@keeltown/core/ports";
import { Layer } from "effect";
import { NamespaceUsageCodecs } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/**
 * The NamespaceUsage port over the NamespaceUsage DO's RPC. Each namespace's counts and
 * settings are the object `usage:<namespaceId>`: the address is the only thing that
 * picks a namespace, since no call carries one. The object touches no repo, so it
 * takes no location hint and is placed near its first caller.
 */
export function NamespaceUsageRpc(objects: Env["NAMESPACE_USAGE"]): Layer.Layer<NamespaceUsage> {
  const usage = (namespace: NamespaceId) =>
    objects.get(objects.idFromName(usageAddress(namespace)));

  return Layer.succeed(
    NamespaceUsage,
    NamespaceUsage.of({
      admit: (namespace, kind, amount, key) =>
        callObject(NamespaceUsageCodecs.admit, () => usage(namespace).admit({ kind, amount, key })),
      record: (namespace, kind, amount, key) =>
        callObject(NamespaceUsageCodecs.record, () =>
          usage(namespace).record({ kind, amount, key }),
        ),
      settings: (namespace) =>
        callObject(NamespaceUsageCodecs.settings, () => usage(namespace).settings()),
      configure: (namespace, settings) =>
        callObject(NamespaceUsageCodecs.configure, () => usage(namespace).configure(settings)),
    }),
  );
}
