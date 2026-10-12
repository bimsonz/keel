import { usageAddress } from "@keeltown/core/application/identity";
import type { OrgId } from "@keeltown/core/kernel";
import { OrgUsage } from "@keeltown/core/ports";
import { Layer } from "effect";
import { OrgUsageCodecs } from "../../../rpc/index.ts";
import { callObject } from "./answer.ts";

/**
 * The OrgUsage port over the OrgUsage DO's RPC. Each org's counts and
 * settings are the object `usage:<orgId>`: the address is the only thing that
 * picks an org, since no call carries one. The object touches no repo, so it
 * takes no location hint and is placed near its first caller.
 */
export function OrgUsageRpc(objects: Env["ORG_USAGE"]): Layer.Layer<OrgUsage> {
  const usage = (org: OrgId) => objects.get(objects.idFromName(usageAddress(org)));

  return Layer.succeed(
    OrgUsage,
    OrgUsage.of({
      admit: (org, kind, amount, key) =>
        callObject(OrgUsageCodecs.admit, () => usage(org).admit({ kind, amount, key })),
      record: (org, kind, amount, key) =>
        callObject(OrgUsageCodecs.record, () => usage(org).record({ kind, amount, key })),
      settings: (org) => callObject(OrgUsageCodecs.settings, () => usage(org).settings()),
      configure: (org, settings) =>
        callObject(OrgUsageCodecs.configure, () => usage(org).configure(settings)),
    }),
  );
}
