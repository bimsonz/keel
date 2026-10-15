import { InstanceQuotasConfig } from "@keeltown/core/ports";
import { Cause, Exit, Schema } from "effect";

// A key the configuration does not know (a misspelt kind) refuses: dropped, it would leave a namespace on the defaults.
const decodeInstanceQuotas = Schema.decodeUnknownExit(InstanceQuotasConfig, {
  onExcessProperty: "error",
});

/**
 * The instance's quota configuration from `KEEL_QUOTAS`, a JSON string that
 * scripts/deploy.ts fills from the operator's file (`"{}"` committed, so an
 * instance with none has the defaults). One that does not decode stops the
 * composition, rather than letting every namespace fall back to the defaults.
 */
export function instanceQuotas(raw: unknown): InstanceQuotasConfig {
  let json: unknown;
  try {
    json = JSON.parse(typeof raw === "string" && raw.trim() !== "" ? raw : "{}");
  } catch (error) {
    throw new Error(`KEEL_QUOTAS is not JSON: ${String(error)}`, { cause: error });
  }
  const decoded = decodeInstanceQuotas(json);
  if (Exit.isFailure(decoded))
    throw new Error(
      `KEEL_QUOTAS is not the instance's quota configuration: ${Cause.pretty(decoded.cause)}`,
    );
  return decoded.value;
}
